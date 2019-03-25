import * as fs from 'fs-extra'
import * as path from 'path'
import { Env, openDbi, Cursor } from 'node-lmdb'
/*var identity = v => v
let compressSync = identity
let uncompressSync = identity*/
import ArrayLikeIterable from '../util/ArrayLikeIterable'
import { Database } from './Database'
import when from '../util/when'
import WeakValueMap from '../util/WeakValueMap'

const STARTING_ARRAY = [null]
const VALUE_OVERFLOW_THRESHOLD = 2048
const AS_STRING = {
	asBuffer: false
}
const AS_BINARY = {
	keyIsBuffer: true
}
const AS_BINARY_ALLOW_NOT_FOUND = {
	keyIsBuffer: true,
	ignoreNotFound: true
}
const READING_TNX = {
	readOnly: true
}
export const allDbs = new Map()
function genericErrorHandler(err) {
	if (err) {
		console.error(err)
	}
}
let env
const EXTENSION = '.mdpack'
export function open(name, options): Database {
	let location = './' + name

	let env = new Env()
	let db
	let committingWrites
	let scheduledWrites
	let scheduledOperations
	let sharedBuffersActive = new WeakValueMap()
	let sharedBuffersToInvalidate = new WeakValueMap()
	let shareId = 0
    fs.ensureDirSync(path.dirname(location))
	options = Object.assign({
		path: location + EXTENSION,
		noSubdir: true,
		maxDbs: 2,
		noMetaSync: true, // we use the completion of the next transaction to mark when a previous transaction is finally durable, plus meta-sync doesn't really wait for flush to finish on windows, so not altogether reliable anyway
		useWritemap: true, // it seems like this makes the dbs slightly more prone to corruption, but definitely still occurs without, and this provides better performance
	}, options)

	if (options && options.clearOnStart) {
		console.info('Removing', location + EXTENSION)
		fs.removeSync(location + EXTENSION)
		console.info('Removed', location + EXTENSION)
	}
	env.open(options)

	function openDB() {
		try {
			db = env.openDbi({
				name: 'data',
				create: true,
				keyIsBuffer: true,
			})
		} catch(error) {
			handleError(error, null, null, openDB)
		}
	}
	openDB()
	const cobaseDb = {
		db,
		env,
		name,
		bytesRead: 0,
		bytesWritten: 0,
		reads: 0,
		writes: 0,
		transactions: 0,
		sharedBufferThreshold: VALUE_OVERFLOW_THRESHOLD, // should be at least 2048 (smaller than that don't go in overflow pages, and they can be copied/moved on any write)
		readTxn: env.beginTxn(READING_TNX),
		sharedBuffersActiveTxn: env.beginTxn(READING_TNX),
		sharedBuffersToInvalidateTxn: env.beginTxn(READING_TNX),
		transaction(execute, noSync, abort) {
			let result
			if (this.writeTxn) {
				// already nested in a transaction, just execute and return
				result = execute()
				if (noSync)
					return result
				else
					return this.onDemandSync
			}
			let txn
			let committed
			try {
				if (!noSync)
					this.scheduleSync()
				this.transactions++
				txn = this.writeTxn = env.beginTxn()
				result = execute()
				if (abort) {
					txn.abort()
				} else {
					txn.commit()
				}
				committed = true
				if (noSync)
					return result
				else
					return this.onDemandSync
			} catch(error) {
				return handleError(error, this, txn, () => this.transaction(execute))
			} finally {
				if (!committed) {
					try {
						txn.abort()
					} catch(error) {}
				}
				this.writeTxn = null
			}
		},
		getSync(id, asBuffer) {
			return this.get(id, asBuffer)
		},
		get(id, options) {
			let idPrimitive
			if (scheduledWrites) {
				idPrimitive = id.toString('binary')
				if (scheduledWrites.has(idPrimitive)) {
					return scheduledWrites.get(idPrimitive)
				}
			}
			if (committingWrites) {
				idPrimitive = idPrimitive || id.toString('binary')
				if (committingWrites.has(idPrimitive)) {
					return committingWrites.get(idPrimitive)
				}
			}

			let txn
			try {
				const writeTxn = this.writeTxn
				if (writeTxn) {
					txn = writeTxn
				} else {
					txn = this.readTxn
					txn.renew()
				}
				let result = txn.getBinaryUnsafe(db, id, AS_BINARY)
				if (result && !(options && options.noCopy)) {
					// make a copy so we aren't referencing shared memory
					result = Buffer.from(result)
				}
				
				if (!writeTxn) {
					txn.reset()
				}
				this.bytesRead += result && result.length || 1
				this.reads++
				if (result !== null) // missing entry, really should be undefined
					return result
			} catch(error) {
				return handleError(error, this, txn, () => this.get(id))
			}
		},
		notifyOnInvalidation(buffer, onInvalidation) {
			if (!buffer)
				return
			let parentArrayBuffer = buffer.buffer // this is the internal ArrayBuffer with that references the external/shared memory
			sharedBuffersActive.set(shareId++, parentArrayBuffer)
			parentArrayBuffer.onInvalidation = onInvalidation
		},
		put(id, value, ifValue) {
			if (!scheduledWrites) {
				scheduledWrites = new Map()
				scheduledOperations = []
			}
			let key = id.toString('binary')
			scheduledWrites.set(key, value)
			let index = scheduledOperations.push([db, id, value, ifValue]) - 1
			let syncResults = this.scheduleCommit()
			return ifValue === undefined ? syncResults :
				new ConditionalWriteResult(syncResults, index)
		},
		putSync(id, value) {
			let txn
			try {
				if (typeof value !== 'object') {
					throw new Error('putting string value')
					value = Buffer.from(value)
				}
				this.bytesWritten += value && value.length || 0
				this.writes++
				txn = this.writeTxn || env.beginTxn()
				txn.putBinary(db, id, value, AS_BINARY)
				if (!this.writeTxn) {
					txn.commit()
				}
			} catch(error) {
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				return handleError(error, this, txn, () => this.put(id, value))
			}
		},
		removeSync(id) {
			let txn
			try {
				txn = this.writeTxn || env.beginTxn()
				this.writes++
				txn.del(db, id)
				if (!this.writeTxn) {
					txn.commit()
					return this.scheduleSync()
				}
				return true // object found and deleted
			} catch(error) {
				if (error.message.startsWith('MDB_NOTFOUND')) {
					if (!this.writeTxn)
						txn.abort()
					return false // calling remove on non-existent property is fine, but we will indicate its lack of existence with the return value
				}
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				return handleError(error, this, txn, () => this.remove(id))
			}
		},
		remove(id, ifValue) {
			if (!scheduledWrites) {
				scheduledWrites = new Map()
				scheduledOperations = []
			}
			scheduledWrites.set(id.toString('binary'))
			let index = scheduledOperations.push([db, id, undefined, ifValue]) - 1
			let syncResults = this.scheduleCommit()
			return ifValue === undefined ? syncResults :
				new ConditionalWriteResult(syncResults, index)
		},
		iterable(options) {
			let iterable = new ArrayLikeIterable()
			iterable[Symbol.iterator] = (async) => {
				let currentKey = options.start || (options.reverse ? Buffer.from([255, 255]) : Buffer.from([0]))
				let endKey = options.end || (options.reverse ? Buffer.from([0]) : Buffer.from([255, 255]))
				const reverse = options.reverse
				let count = 0
				const goToDirection = reverse ? 'goToPrev' : 'goToNext'
				const getNextBlock = () => {
					array = []
					let cursor, txn = cobaseDb.readTxn
					try {
						txn.renew()
						cursor = new Cursor(txn, db, AS_BINARY)
						if (reverse) {
							// for reverse retrieval, goToRange is backwards because it positions at the key equal or *greater than* the provided key
							let nextKey = cursor.goToRange(currentKey)
							if (nextKey) {
								if (!nextKey.equals(currentKey)) {
									// goToRange positioned us at a key after the provided key, so we need to go the previous key to be less than the provided key
									currentKey = cursor.goToPrev()
								} // else they match, we are good, and currentKey is already correct
							} else {
								// likewise, we have been position beyond the end of the index, need to go to last
								currentKey = cursor.goToLast()
							}
						} else {
							// for forward retrieval, goToRange does what we want
							currentKey = cursor.goToRange(currentKey)
						}
						let i = 0
						while (!(finished = currentKey === null || (reverse ? currentKey.compare(endKey) <= 0 : currentKey.compare(endKey) >= 0)) && i++ < 100) {
							try {
								array.push(currentKey, options.values === false ? null : cursor.getCurrentBinary())
							} catch(error) {
								console.log('error uncompressing value for key', currentKey)
							}
							if (count++ >= options.limit) {
								finished = true
								break
							}
							currentKey = cursor[goToDirection]()
						}
						cursor.close()
						txn.reset()
					} catch(error) {
						if (cursor) {
							try {
								cursor.close()
							} catch(error) { }
						}
						return handleError(error, this, txn, getNextBlock)
					}
				}
				let array
				let i = 0
				let finished
				getNextBlock()
				return {
					next() {
						let length = array.length
						if (i === length) {
							if (finished) {
								return { done: true }
							} else {
								getNextBlock()
								i = 0
								return this.next()
							}
						}
						let key = array[i++]
						let value = array[i++]
						cobaseDb.bytesRead += value && value.length || 0
						return {
							value: {
								key, value
							}
						}
					},
					return() {
						console.log('return called on iterator', this.ended)
						return { done: true }
					},
					throw() {
						console.log('throw called on iterator', this.ended)
						return { done: true }
					}
				}
			}
			return iterable
		},
		scheduleCommit() {
			if (!this.pendingBatch) {
				// pendingBatch promise represents the completion of the transaction
				let thisBatch = this.pendingBatch = new Promise((resolve, reject) => {
					when(this.currentBatch, () => {
						setTimeout(() => {
							let currentBatch = this.currentBatch = this.pendingBatch
							this.pendingBatch = null
							this.pendingSync = null
							if (scheduledWrites) {
								// operations to perform, collect them as an array and start doing them
								let operations = scheduledOperations
								committingWrites = scheduledWrites
								scheduledWrites = null
								scheduledOperations = null
								const doBatch = () => {
									console.log('do batch', name, operations.length/*map(o => o[1].toString('binary')).join(',')*/)
									env.batchWrite(operations, AS_BINARY_ALLOW_NOT_FOUND, (error, results) => {
										console.log('did batch', name, operations.length/*map(o => o[1].toString('binary')).join(',')*/)
										if (error) {
											console.log('error in batch', error)
											try {
												// see if we can recover from recoverable error (like full map with a resize)
												handleError(error, this, null, doBatch)
											} catch(error) {
												committingWrites = null // commits are done, can eliminate this now
												reject(error)
											}
										} else {
											committingWrites = null // commits are done, can eliminate this now
											resolve(results)
										}
									})
								}
								doBatch()
							} else {
								let start = Date.now()
								// if no operations are queued, we just do a sync, not transaction necessary
								// TODO: Ideally we'd like this to be only an fdatasync/FlushFileBuffers call, and the map already asyncrhonously flushing for the metadata
								this.sync((error) => {
									if (Date.now() - start > 100)
										console.log('finished sync', name, Date.now(), Date.now() - start)
									if (error)
										reject(error)
									else
										resolve()
								})
							}
						}, 50)
					})
				})
				// pendingBatch promise represents the completion of the transaction, but the metadata update that
				// points to the new transaction is not guaranteed to be written to disk until the next transaction
				// or sync (something that calls fdatasync/FlushFileBuffers)
				this.pendingSynced = {
					// only schedule the follow up sync lazily, if the promise then is actually called
					then: (onFulfilled, onRejected) =>
						// schedule another commit after this one so the meta-data write can be flushed, even if it ends up just being a sync call
						thisBatch.then((results) => {
							this.scheduleCommit()
							return this.pendingBatch.finally(() => onFulfilled(results))
						}),
					// provide access to the transaction promise, since if availability of subsequent read is what is needed,
					// the committed promise provides that (you don't have to wait for disk flush to access the committed data in memory)
					committed: this.pendingBatch
				}
			}
			return this.pendingSynced
		},
		batch(operations) {
			this.writes += operations.length
			this.bytesWritten += operations.reduce((a, b) => a + (b.value && b.value.length || 0), 0)
			for (let operation of operations) {
				if (typeof operation.key != 'object')
					throw new Error('non-buffer key')
				try {
					let value = operation.value
					if (!scheduledWrites) {
						scheduledWrites = new Map()
						scheduledOperations = []
					}
					scheduledWrites.set(operation.key.toString('binary'), value)
					scheduledOperations.push([db, operation.key, value])
				} catch (error) {
					if (error.message.startsWith('MDB_NOTFOUND')) {
						// not an error
					} else {
						throw error
					}
				}
			}
			return this.scheduleCommit()
		},
		close() {
			db.close()
			env.close()
		},
		resetSharedBuffers(force) {
			// these have to overlap, so we can access the old buffers and be assured anything that sticks around still has a read txn before it
			let toAbort = this.sharedBuffersToInvalidateTxn
			this.sharedBuffersToInvalidateTxn = this.sharedBuffersActiveTxn
			if (!force)
				this.sharedBuffersActiveTxn = env.beginTxn(READING_TNX)

			let newSharedBuffersActive = new WeakValueMap();
			[sharedBuffersToInvalidate, sharedBuffersActive].forEach((sharedBuffers, i) => {
				let bufferIds = sharedBuffers._keysAsArray()
				console.log('bufferIds',i,bufferIds)
				for (const id of bufferIds) {
					let buffer = sharedBuffers.get(id)
					let forceUnload = force || buffer.length < VALUE_OVERFLOW_THRESHOLD
					if (buffer && buffer.onInvalidation) {
						if (buffer.onInvalidation(forceUnload || i) === false && !forceUnload) {
							newSharedBuffersActive.set(id, buffer)
						}
						// else false is specifically indicating that the shared buffer is still valid, so keep it around in that case
					}
				}
			})
			if (force) {
				sharedBuffersToInvalidate = new WeakValueMap()
			} else {
				sharedBuffersToInvalidate = sharedBuffersActive
			}
			sharedBuffersActive = newSharedBuffersActive
			try {
				toAbort.abort() // release the previous shared buffer txn
			} catch(error) {
				console.warn(error)
			}
			try {
			if (force) {
				this.sharedBuffersToInvalidateTxn.abort()
			}
			} catch(error) {
				console.warn(error)
			}
		},
		syncAverage: 100,
		scheduleSync() {
			let pendingBatch
			if (this.onDemandSync)
				return this.onDemandSync
			let scheduledMs = this.syncAverage * 100 // with no demand, we schedule syncs very slowly
			let currentTimeout
			const schedule = () => pendingBatch = new Promise((resolve, reject) => {
				when(this.currentBatch, () => {
					//console.log('scheduling sync for', scheduledMs)
					currentTimeout = setTimeout(() => {
						currentTimeout = null
						let currentBatch = this.currentBatch = this.onDemandSync
						this.onDemandSync = null
						let start = Date.now()
						//console.log('syncing', Date.now())
						this.sync((error) => {
							let elapsed = Date.now() - start
							//if (elapsed > 500)
						//		console.log('finished sync', name, elapsed, Date.now())
							this.syncAverage = this.syncAverage / 1.1 + elapsed

							if (error) {
								console.error(error)
							}
							if (currentBatch == this.currentBatch) {
								this.currentBatch = null
							}
							resolve()
							setTimeout(() => {}, 1) // this is to deal with https://github.com/Venemo/node-lmdb/issues/138
						})
					}, scheduledMs).unref()
				})
			})
			schedule()
			let immediateMode

			return this.onDemandSync = {
				then: (callback, errback) => { // this is a semi-lazy promise, we speed up the sync if we detect that someone is demanding a callback
					if (!immediateMode) {
						immediateMode = true
						scheduledMs = this.syncAverage
						if (currentTimeout) {
							// reschedule for sooner if it is waiting for the timeout to finish
							clearTimeout(currentTimeout)
							schedule()
						}
					}
					return pendingBatch.then(callback, errback)
				}
			}
		},
		sync(callback) {
			return env.sync(callback || function(error) {
				if (error) {
					console.error(error)
				}
			})
		},
		clear() {
			//console.log('clearing db', name)
			try {
				db.drop({
					justFreePages: true,
					txn: this.writeTxn,
				})
			} catch(error) {
				handleError(error, this, null, () => this.clear())
			}
		},
		testResize() {
			handleError(new Error('MDB_MAP_FULL'), this, null, () => {
				console.log('done resizing')
			})
		}
	}
	cobaseDb.readTxn.reset()
	allDbs.set(name, cobaseDb)
	return cobaseDb
	function handleError(error, db, txn, retry) {
		try {
			if (db && db.readTxn) {
				db.readTxn.abort()
			}
		} catch(error) {
		//	console.warn('txn already aborted')
		}
		try {
			if (db && db.writeTxn)
				db.writeTxn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}
		try {
			if (txn && txn !== (db && db.readTxn) && txn !== (db && db.writeTxn))
				txn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}

		if (db && db.writeTxn)
			db.writeTxn = null
		if (error.message == 'The transaction is already closed.') {
			try {
				db.readTxn = env.beginTxn(READING_TNX)
			} catch(error) {
				return handleError(error, db, null, retry)
			}
			return retry()
		}
		if (error.message.startsWith('MDB_MAP_FULL') || error.message.startsWith('MDB_MAP_RESIZED')) {
			const newSize = Math.ceil(env.info().mapSize * 1.3 / 0x200000 + 1) * 0x200000
			console.log('Resizing database', name, 'to', newSize)
			if (db) {
				try {
				db.resetSharedBuffers(true)
				}catch (error) {
					console.error(error)
				}
			}
			env.resize(newSize)
			console.log('Resized env, resetting read transactions')
			if (db) {
				db.readTxn = env.beginTxn(READING_TNX)
				db.readTxn.reset()
				db.sharedBuffersActiveTxn = env.beginTxn(READING_TNX)
				db.sharedBuffersToInvalidateTxn = env.beginTxn(READING_TNX)
			}
			console.log('Resized db, retrying last operations', retry)
			let result = retry()
			console.log('Finished retrying last operation')
			return result
		} else if (error.message.startsWith('MDB_PAGE_NOTFOUND') || error.message.startsWith('MDB_CURSOR_FULL') || error.message.startsWith('MDB_CORRUPTED') || error.message.startsWith('MDB_INVALID')) {
			// the noSync setting means that we can have partial corruption and we need to be able to recover
			if (db) {
				db.close()
			}
			try {
				env.close()
			} catch (error) {}
			console.warn('Corrupted database,', location, 'attempting to delete the db file and restart', error)
			fs.removeSync(location + '.mdb')
			env = new Env()
			env.open(options)
			openDB()
			return retry()
		}
		db.readTxn = env.beginTxn(READING_TNX)
		db.readTxn.reset()
		error.message = 'In database ' + name + ': ' + error.message
		throw error
	}
}

class ConditionalWriteResult {
	syncResults
	index: number
	constructor(syncResults, index) {
		this.syncResults = syncResults
		this.index = index
	}
	_synced
	get synced() {
		return this._synced || (this._synced = this.syncResults.then((writeResults) =>
			writeResults[this.index] === 0)) // 0 is success
	}
	_committed
	get committed() {
		return this._committed || (this._committed = this.syncResults.committed.then((writeResults) =>
			writeResults[this.index] === 0))
	}
	get written() {
		// TODO: If we provide progress events, we can fulfill this as soon as this is written in the transaction
		return this.committed
	}
	then(onFulfilled, onRejected) {
		return this.synced.then(onFulfilled, onRejected)
	}
}
