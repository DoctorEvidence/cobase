import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { createSerializeStream, createParseStream } from 'dpack'
import { spawn, UpdateEvent, currentContext } from 'alkali'
import { CurrentRequestContext } from '../RequestContext'

let pipeServerStarted
const classMap = new Map<string, any>()
const streamByPidClass = new Map<string, any>()
const streamsByClass = new Map<string, any[]>()
const waitingRequests = new Map<number, { resolve: Function, reject: Function}>()
const whenProcessConnected = new Map<number, Promise<any>>()

const getPipePath = (processId) => path.join(path.sep == '/' ? '/tmp' : '\\\\?\\pipe', 'cobase-' + processId)
let nextRequestId = 1

function startPipeClient(processId, Class) {
	let whenConnected
	if (whenProcessConnected.has(processId)) {
		whenConnected = whenProcessConnected.get(processId)
	} else {
		whenConnected = new Promise((resolve, reject) => {
			const socket = net.createConnection(getPipePath(processId))
			let parsedStream = socket.pipe(createParseStream({
				//encoding: 'utf16le',
			})).on('error', (error) => {
				console.error('Error in pipe client socket', error)
			})
			let serializingStream = createSerializeStream({
				//encoding: 'utf16le'
			})
			serializingStream.pipe(socket)
			serializingStream.pid = processId
			socket.on('error', reject).on('connect', () => resolve(serializingStream))
			socket.unref()
			parsedStream.on('data', (message) => {
				onMessage(message, serializingStream)
			})
		})
		whenProcessConnected.set(processId, whenConnected)
	}
	return whenConnected.then(stream => {
		attachClass(stream, Class, processId)
		// declare this class listens on this stream, by sending out a process identification
		stream.write({
			className: Class.name,
			pid: process.pid
		})
	})
}


function startPipeServer() {
	if (pipeServerStarted)
		return
	pipeServerStarted = true
	net.createServer((socket) => {
		socket.pipe(createParseStream({
			//encoding: 'utf16le',
		})).on('data', (message) => {
			onMessage(message, serializingStream)
		})
		let serializingStream = createSerializeStream({
			encoding: 'utf16le',
		})
		serializingStream.pipe(socket)
		serializingStream.isIncoming = true
	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(getPipePath(process.pid))
}
startPipeServer() // Maybe start it in the next event turn so you can turn it off in single process environment?

function attachClasses(stream) {
	for (const [className, Class] of classMap) {
		attachClass(stream, Class, className)
	}
}
function attachClass(stream, Class, processId) {
	stream.pid = processId
	const className = Class.name
	let streams = streamsByClass.get(className)
	if (!streams) {
		streamsByClass.set(className, streams = [])
	}
	streams.push(stream)
	streamByPidClass.set(processId + '-' + className, stream)
	const otherProcesses = Class.otherProcesses || (Class.otherProcesses = [])
	if (!otherProcesses.includes(processId)) {
		otherProcesses.push(processId)
	}
	const updater = {
		updated(event, by) {
			// TODO: debounce
			//console.log('sending update event', className, process.pid)
			let id = by && by.id
			if (id && by === event.source) {
				try {
					const eventToSerialize = Object.assign({}, event, {
						instanceId: id,
						method: 'updated',
						className,
						type: event.type,
					})
					delete eventToSerialize.visited
					delete eventToSerialize.source
					delete eventToSerialize.previousValues
					stream.write(eventToSerialize)
				} catch(error) {
					// TODO: Not sure how we get in this state
					console.warn(error)
					Class.stopNotifies(updater)
				}
			}
		},
		stream,
		Class
	}
	Class.notifies(updater)
	Class.sendBroadcast = notification => {
		for (const stream of streams) {
			notification.className = className
			stream.write(notification)
		}
	}
	Class.sendRequestToProcess = (pid, message) => {
		const requestId = message.requestId = nextRequestId++
		message.className = Class.name
		const stream = streamByPidClass.get(pid + '-' + className)
		if (!stream) {
			// TODO: If it is undefined wait for a connection
			throw new Error('No socket to process ' + pid)
		}
		stream.write(message)
		return new Promise((resolve, reject) => waitingRequests.set(requestId, { resolve, reject }))
	}
	stream.setMaxListeners(100) // we are going to be adding a lot here
	stream.on('close', () => {
		Class.stopNotifies(updater)
		streams.splice(streams.indexOf(stream), 1)
		streamByPidClass.delete(processId + '-' + className)
	})
}

function onMessage(message, stream) {
	try {
		const { requestId, responseId, className, instanceId } = message

		if (responseId) {
			const resolver = waitingRequests.get(responseId)
			waitingRequests.delete(responseId)
			return resolver.resolve(message)
		}
		let target = classMap.get(className)
		if (target) {
			if (instanceId) {
				//console.log('<<<', message.type, message.className, message.instanceId)
				if (!target.instancesById) {
					console.log('Process proxy didnt have instancesById', target.name)
					target.initialize()
				}
				target = target.instancesById.get(instanceId)
				if (!target) {
					return
				}
			}
			if (requestId) {
				when(target.receiveRequest(message), (result) => {
					result.responseId = requestId
					stream.write(result)
				})
			} else {
				if (message.type) {
					const event = new UpdateEvent()
					event.sourceProcess = stream.pid
					event.source = { id: instanceId, remote: true }
					Object.assign(event, message)
					target.updated(event)
				} else if (message.pid) {
					attachClass(stream, target, message.pid)
				} else {
					target.update(message)
				}
			}
		} else {
			console.warn('Unknown message received', message)
		}
	} catch(error) {
		console.error('Handling message error', error)
	}
}


export function registerClass(Class) {
	classMap.set(Class.name, Class)
}

export function addProcess(pid, Class) {
	return startPipeClient(pid, Class)
}

/*function onCloseSocket(stream, processId) {
	const pid = stream.pid
	let index = streams.indexOf(stream)
	if (index > -1)
		streams.splice(index, 1)
	let removed = 0
	for (let updater of updaters) {
		if (updater.stream === stream) {
			//console.log('stop notifications for', process.pid, 'from', pid)
			removed++
			updater.Class.stopNotifies(updater)
			index = updaters.indexOf(updater)
			if (index > -1)
				updaters.splice(index, 1)
		}
	}
	console.log('socket close from', process.pid, 'to', processId, pid, 'removed updaters', removed)
	streamByPid.set(pid, null) // set it to null, so we now it once existed and is dead
}

/*
// every child process should be ready to join the network
process.on('message', (data) => {
	if (data.enterNetwork) {
		console.log('Received request to start pipe server')
		// create pipe server
		startPipeServer()
		// need to send confirmation that it is set up.
		process.send({
			enteredNetwork: true
		})
	} else if (data.connectToProcess) {
		startPipeClient(data.connectToProcess)
	}
})
*/
