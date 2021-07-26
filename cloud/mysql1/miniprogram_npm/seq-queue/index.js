module.exports = (function() {
var __MODS__ = {};
var __DEFINE__ = function(modId, func, req) { var m = { exports: {}, _tempexports: {} }; __MODS__[modId] = { status: 0, func: func, req: req, m: m }; };
var __REQUIRE__ = function(modId, source) { if(!__MODS__[modId]) return require(source); if(!__MODS__[modId].status) { var m = __MODS__[modId].m; m._exports = m._tempexports; var desp = Object.getOwnPropertyDescriptor(m, "exports"); if (desp && desp.configurable) Object.defineProperty(m, "exports", { set: function (val) { if(typeof val === "object" && val !== m._exports) { m._exports.__proto__ = val.__proto__; Object.keys(val).forEach(function (k) { m._exports[k] = val[k]; }); } m._tempexports = val }, get: function () { return m._tempexports; } }); __MODS__[modId].status = 1; __MODS__[modId].func(__MODS__[modId].req, m, m.exports); } return __MODS__[modId].m.exports; };
var __REQUIRE_WILDCARD__ = function(obj) { if(obj && obj.__esModule) { return obj; } else { var newObj = {}; if(obj != null) { for(var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) newObj[k] = obj[k]; } } newObj.default = obj; return newObj; } };
var __REQUIRE_DEFAULT__ = function(obj) { return obj && obj.__esModule ? obj.default : obj; };
__DEFINE__(1619928528914, function(require, module, exports) {
module.exports = require('./lib/seq-queue');
}, function(modId) {var map = {"./lib/seq-queue":1619928528915}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528915, function(require, module, exports) {
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var DEFAULT_TIMEOUT = 3000;
var INIT_ID = 0;
var EVENT_CLOSED = 'closed';
var EVENT_DRAINED = 'drained';

/**
 * Instance a new queue
 *
 * @param {Number} timeout a global timeout for new queue
 * @class
 * @constructor
 */
var SeqQueue = function(timeout) {
	EventEmitter.call(this);
	
	if(timeout && timeout > 0) {
		this.timeout = timeout;
	} else {
		this.timeout = DEFAULT_TIMEOUT;
	}
	
	this.status = SeqQueueManager.STATUS_IDLE;
	this.curId = INIT_ID;
	this.queue = [];
};
util.inherits(SeqQueue, EventEmitter);

/**
 * Add a task into queue.
 * 
 * @param fn new request
 * @param ontimeout callback when task timeout
 * @param timeout timeout for current request. take the global timeout if this is invalid
 * @returns true or false
 */
SeqQueue.prototype.push = function(fn, ontimeout, timeout) {
	if(this.status !== SeqQueueManager.STATUS_IDLE && this.status !== SeqQueueManager.STATUS_BUSY) {
		//ignore invalid status
		return false;
	}
	
	if(typeof fn !== 'function') {
		throw new Error('fn should be a function.');
	}
	this.queue.push({fn: fn, ontimeout: ontimeout, timeout: timeout});

	if(this.status === SeqQueueManager.STATUS_IDLE) {
		this.status = SeqQueueManager.STATUS_BUSY;
		var self = this;
		process.nextTick(function() {
			self._next(self.curId);
		});
	}
	return true;
};

/**
 * Close queue
 * 
 * @param {Boolean} force if true will close the queue immediately else will execute the rest task in queue
 */
SeqQueue.prototype.close = function(force) {
	if(this.status !== SeqQueueManager.STATUS_IDLE && this.status !== SeqQueueManager.STATUS_BUSY) {
		//ignore invalid status
		return;
	}
	
	if(force) {
		this.status = SeqQueueManager.STATUS_DRAINED;
		if(this.timerId) {
			clearTimeout(this.timerId);
			this.timerId = undefined;
		}
		this.emit(EVENT_DRAINED);
	} else {
		this.status = SeqQueueManager.STATUS_CLOSED;
		this.emit(EVENT_CLOSED);
	}
};

/**
 * Invoke next task
 * 
 * @param {String|Number} tid last executed task id
 * @api private
 */
SeqQueue.prototype._next = function(tid) {
	if(tid !== this.curId || this.status !== SeqQueueManager.STATUS_BUSY && this.status !== SeqQueueManager.STATUS_CLOSED) {
		//ignore invalid next call
		return;
	}
	
	if(this.timerId) {
		clearTimeout(this.timerId);
		this.timerId = undefined;
	}
	
	var task = this.queue.shift();
	if(!task) {
		if(this.status === SeqQueueManager.STATUS_BUSY) {
			this.status = SeqQueueManager.STATUS_IDLE;
			this.curId++;	//modify curId to invalidate timeout task
		} else {
			this.status = SeqQueueManager.STATUS_DRAINED;
			this.emit(EVENT_DRAINED);
		}
		return;
	}
	
	var self = this;
	task.id = ++this.curId;

	var timeout = task.timeout > 0 ? task.timeout : this.timeout;
	timeout = timeout > 0 ? timeout : DEFAULT_TIMEOUT;
	this.timerId = setTimeout(function() {
		process.nextTick(function() {
			self._next(task.id);
		});
		self.emit('timeout', task);
		if(task.ontimeout) {
			task.ontimeout();
		}
	}, timeout);

	try {
		task.fn({
			done: function() {
				var res = task.id === self.curId;
				process.nextTick(function() {
					self._next(task.id);
				});
				return res;
			}
		});
	} catch(err) {
		self.emit('error', err, task);
		process.nextTick(function() {
			self._next(task.id);
		});
	}
};

/**
 * Queue manager.
 * 
 * @module
 */
var SeqQueueManager = module.exports;

/**
 * Queue status: idle, welcome new tasks
 *
 * @const
 * @type {Number}
 * @memberOf SeqQueueManager
 */
SeqQueueManager.STATUS_IDLE = 0;

/**
 * Queue status: busy, queue is working for some tasks now
 *
 * @const
 * @type {Number}
 * @memberOf SeqQueueManager
 */
SeqQueueManager.STATUS_BUSY = 1;

/**
 * Queue status: closed, queue has closed and would not receive task any more 
 * 					and is processing the remaining tasks now.
 *
 * @const
 * @type {Number}
 * @memberOf SeqQueueManager
 */
SeqQueueManager.STATUS_CLOSED = 2; 

/**
 * Queue status: drained, queue is ready to be destroy
 *
 * @const
 * @type {Number}
 * @memberOf SeqQueueManager
 */
SeqQueueManager.STATUS_DRAINED = 3;

/**
 * Create Sequence queue
 * 
 * @param  {Number} timeout a global timeout for the new queue instance
 * @return {Object}         new queue instance
 * @memberOf SeqQueueManager
 */
SeqQueueManager.createQueue = function(timeout) {
	return new SeqQueue(timeout);
};
}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
return __REQUIRE__(1619928528914);
})()
//# sourceMappingURL=index.js.map