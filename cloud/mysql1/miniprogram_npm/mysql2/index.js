module.exports = (function() {
var __MODS__ = {};
var __DEFINE__ = function(modId, func, req) { var m = { exports: {}, _tempexports: {} }; __MODS__[modId] = { status: 0, func: func, req: req, m: m }; };
var __REQUIRE__ = function(modId, source) { if(!__MODS__[modId]) return require(source); if(!__MODS__[modId].status) { var m = __MODS__[modId].m; m._exports = m._tempexports; var desp = Object.getOwnPropertyDescriptor(m, "exports"); if (desp && desp.configurable) Object.defineProperty(m, "exports", { set: function (val) { if(typeof val === "object" && val !== m._exports) { m._exports.__proto__ = val.__proto__; Object.keys(val).forEach(function (k) { m._exports[k] = val[k]; }); } m._tempexports = val }, get: function () { return m._tempexports; } }); __MODS__[modId].status = 1; __MODS__[modId].func(__MODS__[modId].req, m, m.exports); } return __MODS__[modId].m.exports; };
var __REQUIRE_WILDCARD__ = function(obj) { if(obj && obj.__esModule) { return obj; } else { var newObj = {}; if(obj != null) { for(var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) newObj[k] = obj[k]; } } newObj.default = obj; return newObj; } };
var __REQUIRE_DEFAULT__ = function(obj) { return obj && obj.__esModule ? obj.default : obj; };
__DEFINE__(1619928528772, function(require, module, exports) {


const SqlString = require('sqlstring');

const Connection = require('./lib/connection.js');
const ConnectionConfig = require('./lib/connection_config.js');
const parserCache = require('./lib/parsers/parser_cache');

exports.createConnection = function(opts) {
  return new Connection({ config: new ConnectionConfig(opts) });
};

exports.connect = exports.createConnection;
exports.Connection = Connection;

const Pool = require('./lib/pool.js');

exports.createPool = function(config) {
  const PoolConfig = require('./lib/pool_config.js');
  return new Pool({ config: new PoolConfig(config) });
};

exports.createPoolCluster = function(config) {
  const PoolCluster = require('./lib/pool_cluster.js');
  return new PoolCluster(config);
};

exports.createQuery = Connection.createQuery;

exports.Pool = Pool;

exports.createServer = function(handler) {
  const Server = require('./lib/server.js');
  const s = new Server();
  if (handler) {
    s.on('connection', handler);
  }
  return s;
};

exports.PoolConnection = require('./lib/pool_connection');
exports.escape = SqlString.escape;
exports.escapeId = SqlString.escapeId;
exports.format = SqlString.format;
exports.raw = SqlString.raw;

exports.__defineGetter__(
  'createConnectionPromise',
  () => require('./promise.js').createConnection
);

exports.__defineGetter__(
  'createPoolPromise',
  () => require('./promise.js').createPool
);

exports.__defineGetter__(
  'createPoolClusterPromise',
  () => require('./promise.js').createPoolCluster
);

exports.__defineGetter__('Types', () => require('./lib/constants/types.js'));

exports.__defineGetter__('Charsets', () =>
  require('./lib/constants/charsets.js')
);

exports.__defineGetter__('CharsetToEncoding', () =>
  require('./lib/constants/charset_encodings.js')
);

exports.setMaxParserCache = function(max) {
  parserCache.setMaxCache(max);
};

exports.clearParserCache = function() {
  parserCache.clearCache();
};

}, function(modId) {var map = {"./lib/connection.js":1619928528773,"./lib/connection_config.js":1619928528831,"./lib/parsers/parser_cache":1619928528819,"./lib/pool.js":1619928528834,"./lib/pool_config.js":1619928528836,"./lib/pool_cluster.js":1619928528837,"./lib/server.js":1619928528838,"./lib/pool_connection":1619928528835,"./promise.js":1619928528833,"./lib/constants/types.js":1619928528783,"./lib/constants/charsets.js":1619928528817,"./lib/constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528773, function(require, module, exports) {


const Net = require('net');
const Tls = require('tls');
const Timers = require('timers');
const EventEmitter = require('events').EventEmitter;
const Readable = require('stream').Readable;
const Queue = require('denque');
const SqlString = require('sqlstring');
const LRU = require('lru-cache');

const PacketParser = require('./packet_parser.js');
const Packets = require('./packets/index.js');
const Commands = require('./commands/index.js');
const ConnectionConfig = require('./connection_config.js');
const CharsetToEncoding = require('./constants/charset_encodings.js');

let _connectionId = 0;

let convertNamedPlaceholders = null;

class Connection extends EventEmitter {
  constructor(opts) {
    super();
    this.config = opts.config;
    // TODO: fill defaults
    // if no params, connect to /var/lib/mysql/mysql.sock ( /tmp/mysql.sock on OSX )
    // if host is given, connect to host:3306
    // TODO: use `/usr/local/mysql/bin/mysql_config --socket` output? as default socketPath
    // if there is no host/port and no socketPath parameters?
    if (!opts.config.stream) {
      if (opts.config.socketPath) {
        this.stream = Net.connect(opts.config.socketPath);
      } else {
        this.stream = Net.connect(
          opts.config.port,
          opts.config.host
        );

        // Enable keep-alive on the socket.  It's disabled by default, but the
        // user can enable it and supply an initial delay.
        this.stream.setKeepAlive(true, this.config.keepAliveInitialDelay);
      }
      // if stream is a function, treat it as "stream agent / factory"
    } else if (typeof opts.config.stream === 'function')  {
      this.stream = opts.config.stream(opts);
    } else {
      this.stream = opts.config.stream;
    }

    this._internalId = _connectionId++;
    this._commands = new Queue();
    this._command = null;
    this._paused = false;
    this._paused_packets = new Queue();
    this._statements = new LRU({
      max: this.config.maxPreparedStatements,
      dispose: function(key, statement) {
        statement.close();
      }
    });
    this.serverCapabilityFlags = 0;
    this.authorized = false;
    this.sequenceId = 0;
    this.compressedSequenceId = 0;
    this.threadId = null;
    this._handshakePacket = null;
    this._fatalError = null;
    this._protocolError = null;
    this._outOfOrderPackets = [];
    this.clientEncoding = CharsetToEncoding[this.config.charsetNumber];
    this.stream.on('error', this._handleNetworkError.bind(this));
    // see https://gist.github.com/khoomeister/4985691#use-that-instead-of-bind
    this.packetParser = new PacketParser(p => {
      this.handlePacket(p);
    });
    this.stream.on('data', data => {
      if (this.connectTimeout) {
        Timers.clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.packetParser.execute(data);
    });
    this.stream.on('close', () => {
      // we need to set this flag everywhere where we want connection to close
      if (this._closing) {
        return;
      }
      if (!this._protocolError) {
        // no particular error message before disconnect
        this._protocolError = new Error(
          'Connection lost: The server closed the connection.'
        );
        this._protocolError.fatal = true;
        this._protocolError.code = 'PROTOCOL_CONNECTION_LOST';
      }
      this._notifyError(this._protocolError);
    });
    let handshakeCommand;
    if (!this.config.isServer) {
      handshakeCommand = new Commands.ClientHandshake(this.config.clientFlags);
      handshakeCommand.on('end', () => {
        // this happens when handshake finishes early and first packet is error
        // and not server hello ( for example, 'Too many connactions' error)
        if (!handshakeCommand.handshake) {
          return;
        }
        this._handshakePacket = handshakeCommand.handshake;
        this.threadId = handshakeCommand.handshake.connectionId;
        this.emit('connect', handshakeCommand.handshake);
      });
      handshakeCommand.on('error', err => {
        this._closing = true;
        this._notifyError(err);
      });
      this.addCommand(handshakeCommand);
    }
    // in case there was no initiall handshake but we need to read sting, assume it utf-8
    // most common example: "Too many connections" error ( packet is sent immediately on connection attempt, we don't know server encoding yet)
    // will be overwrittedn with actial encoding value as soon as server handshake packet is received
    this.serverEncoding = 'utf8';
    if (this.config.connectTimeout) {
      const timeoutHandler = this._handleTimeoutError.bind(this);
      this.connectTimeout = Timers.setTimeout(
        timeoutHandler,
        this.config.connectTimeout
      );
    }
  }

  promise(promiseImpl) {
    const PromiseConnection = require('../promise').PromiseConnection;
    return new PromiseConnection(this, promiseImpl);
  }

  _addCommandClosedState(cmd) {
    const err = new Error(
      "Can't add new command when connection is in closed state"
    );
    err.fatal = true;
    if (cmd.onResult) {
      cmd.onResult(err);
    } else {
      this.emit('error', err);
    }
  }

  _handleFatalError(err) {
    err.fatal = true;
    // stop receiving packets
    this.stream.removeAllListeners('data');
    this.addCommand = this._addCommandClosedState;
    this.write = () => {
      this.emit('error', new Error("Can't write in closed state"));
    };
    this._notifyError(err);
    this._fatalError = err;
  }

  _handleNetworkError(err) {
    if (this.connectTimeout) {
      Timers.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    // Do not throw an error when a connection ends with a RST,ACK packet
    if (err.errno === 'ECONNRESET' && this._closing) {
      return;
    }
    this._handleFatalError(err);
  }

  _handleTimeoutError() {
    if (this.connectTimeout) {
      Timers.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.stream.destroy && this.stream.destroy();
    const err = new Error('connect ETIMEDOUT');
    err.errorno = 'ETIMEDOUT';
    err.code = 'ETIMEDOUT';
    err.syscall = 'connect';
    this._handleNetworkError(err);
  }

  // notify all commands in the queue and bubble error as connection "error"
  // called on stream error or unexpected termination
  _notifyError(err) {
    if (this.connectTimeout) {
      Timers.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }    
    // prevent from emitting 'PROTOCOL_CONNECTION_LOST' after EPIPE or ECONNRESET
    if (this._fatalError) {
      return;
    }
    let command;
    // if there is no active command, notify connection
    // if there are commands and all of them have callbacks, pass error via callback
    let bubbleErrorToConnection = !this._command;
    if (this._command && this._command.onResult) {
      this._command.onResult(err);
      this._command = null;
      // connection handshake is special because we allow it to be implicit
      // if error happened during handshake, but there are others commands in queue
      // then bubble error to other commands and not to connection
    } else if (
      !(
        this._command &&
        this._command.constructor === Commands.ClientHandshake &&
        this._commands.length > 0
      )
    ) {
      bubbleErrorToConnection = true;
    }
    while ((command = this._commands.shift())) {
      if (command.onResult) {
        command.onResult(err);
      } else {
        bubbleErrorToConnection = true;
      }
    }
    // notify connection if some comands in the queue did not have callbacks
    // or if this is pool connection ( so it can be removed from pool )
    if (bubbleErrorToConnection || this._pool) {
      this.emit('error', err);
    }
  }

  write(buffer) {
    const result = this.stream.write(buffer, err => {
      if (err) {
        this._handleNetworkError(err);
      }
    });

    if (!result) {
      this.stream.emit('pause');
    }
  }

  // http://dev.mysql.com/doc/internals/en/sequence-id.html
  //
  // The sequence-id is incremented with each packet and may wrap around.
  // It starts at 0 and is reset to 0 when a new command
  // begins in the Command Phase.
  // http://dev.mysql.com/doc/internals/en/example-several-mysql-packets.html
  _resetSequenceId() {
    this.sequenceId = 0;
    this.compressedSequenceId = 0;
  }

  _bumpCompressedSequenceId(numPackets) {
    this.compressedSequenceId += numPackets;
    this.compressedSequenceId %= 256;
  }

  _bumpSequenceId(numPackets) {
    this.sequenceId += numPackets;
    this.sequenceId %= 256;
  }

  writePacket(packet) {
    const MAX_PACKET_LENGTH = 16777215;
    const length = packet.length();
    let chunk, offset, header;
    if (length < MAX_PACKET_LENGTH) {
      packet.writeHeader(this.sequenceId);
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `${this._internalId} ${this.connectionId} <== ${this._command._commandName}#${this._command.stateName()}(${[this.sequenceId, packet._name, packet.length()].join(',')})`
        );
        // eslint-disable-next-line no-console
        console.log(
          `${this._internalId} ${this.connectionId} <== ${packet.buffer.toString('hex')}`
        );
      }
      this._bumpSequenceId(1);
      this.write(packet.buffer);
    } else {
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `${this._internalId} ${this.connectionId} <== Writing large packet, raw content not written:`
        );
        // eslint-disable-next-line no-console
        console.log(
          `${this._internalId} ${this.connectionId} <== ${this._command._commandName}#${this._command.stateName()}(${[this.sequenceId, packet._name, packet.length()].join(',')})`
        );
      }
      for (offset = 4; offset < 4 + length; offset += MAX_PACKET_LENGTH) {
        chunk = packet.buffer.slice(offset, offset + MAX_PACKET_LENGTH);
        if (chunk.length === MAX_PACKET_LENGTH) {
          header = Buffer.from([0xff, 0xff, 0xff, this.sequenceId]);
        } else {
          header = Buffer.from([
            chunk.length & 0xff,
            (chunk.length >> 8) & 0xff,
            (chunk.length >> 16) & 0xff,
            this.sequenceId
          ]);
        }
        this._bumpSequenceId(1);
        this.write(header);
        this.write(chunk);
      }
    }
  }

  // 0.11+ environment
  startTLS(onSecure) {
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.log('Upgrading connection to TLS');
    }
    const secureContext = Tls.createSecureContext({
      ca: this.config.ssl.ca,
      cert: this.config.ssl.cert,
      ciphers: this.config.ssl.ciphers,
      key: this.config.ssl.key,
      passphrase: this.config.ssl.passphrase,
      minVersion: this.config.ssl.minVersion
    });
    const rejectUnauthorized = this.config.ssl.rejectUnauthorized;
    let secureEstablished = false;
    const secureSocket = new Tls.TLSSocket(this.stream, {
      rejectUnauthorized: rejectUnauthorized,
      requestCert: true,
      secureContext: secureContext,
      isServer: false
    });
    // error handler for secure socket
    secureSocket.on('_tlsError', err => {
      if (secureEstablished) {
        this._handleNetworkError(err);
      } else {
        onSecure(err);
      }
    });
    secureSocket.on('secure', () => {
      secureEstablished = true;
      onSecure(rejectUnauthorized ? secureSocket.ssl.verifyError() : null);
    });
    secureSocket.on('data', data => {
      this.packetParser.execute(data);
    });
    this.write = buffer => {
      secureSocket.write(buffer);
    };
    // start TLS communications
    secureSocket._start();
  }

  pipe() {
    if (this.stream instanceof Net.Stream) {
      this.stream.ondata = (data, start, end) => {
        this.packetParser.execute(data, start, end);
      };
    } else {
      this.stream.on('data', data => {
        this.packetParser.execute(
          data.parent,
          data.offset,
          data.offset + data.length
        );
      });
    }
  }

  protocolError(message, code) {
    const err = new Error(message);
    err.fatal = true;
    err.code = code || 'PROTOCOL_ERROR';
    this.emit('error', err);
  }

  handlePacket(packet) {
    if (this._paused) {
      this._paused_packets.push(packet);
      return;
    }
    if (packet) {
      if (this.sequenceId !== packet.sequenceId) {
        const err = new Error(
          `Warning: got packets out of order. Expected ${this.sequenceId} but received ${packet.sequenceId}`
        );
        err.expected = this.sequenceId;
        err.received = packet.sequenceId;
        this.emit('warn', err); // REVIEW
        // eslint-disable-next-line no-console
        console.error(err.message);
      }
      this._bumpSequenceId(packet.numPackets);
    }
    if (this.config.debug) {
      if (packet) {
        // eslint-disable-next-line no-console
        console.log(
          ` raw: ${packet.buffer
            .slice(packet.offset, packet.offset + packet.length())
            .toString('hex')}`
        );
        // eslint-disable-next-line no-console
        console.trace();
        const commandName = this._command
          ? this._command._commandName
          : '(no command)';
        const stateName = this._command
          ? this._command.stateName()
          : '(no command)';
        // eslint-disable-next-line no-console
        console.log(
          `${this._internalId} ${this.connectionId} ==> ${commandName}#${stateName}(${[packet.sequenceId, packet.type(), packet.length()].join(',')})`
        );
      }
    }
    if (!this._command) {
      this.protocolError(
        'Unexpected packet while no commands in the queue',
        'PROTOCOL_UNEXPECTED_PACKET'
      );
      this.close();
      return;
    }
    const done = this._command.execute(packet, this);
    if (done) {
      this._command = this._commands.shift();
      if (this._command) {
        this.sequenceId = 0;
        this.compressedSequenceId = 0;
        this.handlePacket();
      }
    }
  }

  addCommand(cmd) {
    // this.compressedSequenceId = 0;
    // this.sequenceId = 0;
    if (this.config.debug) {
      const commandName = cmd.constructor.name;
      // eslint-disable-next-line no-console
      console.log(`Add command: ${commandName}`);
      cmd._commandName = commandName;
    }
    if (!this._command) {
      this._command = cmd;
      this.handlePacket();
    } else {
      this._commands.push(cmd);
    }
    return cmd;
  }

  format(sql, values) {
    if (typeof this.config.queryFormat === 'function') {
      return this.config.queryFormat.call(
        this,
        sql,
        values,
        this.config.timezone
      );
    }
    const opts = {
      sql: sql,
      values: values
    };
    this._resolveNamedPlaceholders(opts);
    return SqlString.format(
      opts.sql,
      opts.values,
      this.config.stringifyObjects,
      this.config.timezone
    );
  }

  escape(value) {
    return SqlString.escape(value, false, this.config.timezone);
  }

  escapeId(value) {
    return SqlString.escapeId(value, false);
  }

  raw(sql) {
    return SqlString.raw(sql);
  }

  _resolveNamedPlaceholders(options) {
    let unnamed;
    if (this.config.namedPlaceholders || options.namedPlaceholders) {
      if (convertNamedPlaceholders === null) {
        convertNamedPlaceholders = require('named-placeholders')();
      }
      unnamed = convertNamedPlaceholders(options.sql, options.values);
      options.sql = unnamed[0];
      options.values = unnamed[1];
    }
  }

  query(sql, values, cb) {
    let cmdQuery;
    if (sql.constructor === Commands.Query) {
      cmdQuery = sql;
    } else {
      cmdQuery = Connection.createQuery(sql, values, cb, this.config);
    }
    this._resolveNamedPlaceholders(cmdQuery);
    const rawSql = this.format(cmdQuery.sql, cmdQuery.values !== undefined ? cmdQuery.values : []);
    cmdQuery.sql = rawSql;
    return this.addCommand(cmdQuery);
  }

  pause() {
    this._paused = true;
    this.stream.pause();
  }

  resume() {
    let packet;
    this._paused = false;
    while ((packet = this._paused_packets.shift())) {
      this.handlePacket(packet);
      // don't resume if packet hander paused connection
      if (this._paused) {
        return;
      }
    }
    this.stream.resume();
  }

  // TODO: named placeholders support
  prepare(options, cb) {
    if (typeof options === 'string') {
      options = { sql: options };
    }
    return this.addCommand(new Commands.Prepare(options, cb));
  }

  unprepare(sql) {
    let options = {};
    if (typeof sql === 'object') {
      options = sql;
    } else {
      options.sql = sql;
    }
    const key = Connection.statementKey(options);
    const stmt = this._statements.get(key);
    if (stmt) {
      this._statements.del(key);
      stmt.close();
    }
    return stmt;
  }

  execute(sql, values, cb) {
    let options = {};
    if (typeof sql === 'object') {
      // execute(options, cb)
      options = sql;
      if (typeof values === 'function') {
        cb = values;
      } else {
        options.values = options.values || values;
      }
    } else if (typeof values === 'function') {
      // execute(sql, cb)
      cb = values;
      options.sql = sql;
      options.values = undefined;
    } else {
      // execute(sql, values, cb)
      options.sql = sql;
      options.values = values;
    }
    this._resolveNamedPlaceholders(options);
    // check for values containing undefined
    if (options.values) {
      //If namedPlaceholder is not enabled and object is passed as bind parameters
      if (!Array.isArray(options.values)) {
        throw new TypeError(
          'Bind parameters must be array if namedPlaceholders parameter is not enabled'
        );
      }
      options.values.forEach(val => {
        //If namedPlaceholder is not enabled and object is passed as bind parameters
        if (!Array.isArray(options.values)) {
          throw new TypeError(
            'Bind parameters must be array if namedPlaceholders parameter is not enabled'
          );
        }
        if (val === undefined) {
          throw new TypeError(
            'Bind parameters must not contain undefined. To pass SQL NULL specify JS null'
          );
        }
        if (typeof val === 'function') {
          throw new TypeError(
            'Bind parameters must not contain function(s). To pass the body of a function as a string call .toString() first'
          );
        }
      });
    }
    const executeCommand = new Commands.Execute(options, cb);
    const prepareCommand = new Commands.Prepare(options, (err, stmt) => {
      if (err) {
        // skip execute command if prepare failed, we have main
        // combined callback here
        executeCommand.start = function() {
          return null;
        };
        if (cb) {
          cb(err);
        } else {
          executeCommand.emit('error', err);
        }
        executeCommand.emit('end');
        return;
      }
      executeCommand.statement = stmt;
    });
    this.addCommand(prepareCommand);
    this.addCommand(executeCommand);
    return executeCommand;
  }

  changeUser(options, callback) {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    }
    const charsetNumber = options.charset
      ? ConnectionConfig.getCharsetNumber(options.charset)
      : this.config.charsetNumber;
    return this.addCommand(
      new Commands.ChangeUser(
        {
          user: options.user || this.config.user,
          password: options.password || this.config.password,
          passwordSha1: options.passwordSha1 || this.config.passwordSha1,
          database: options.database || this.config.database,
          timeout: options.timeout,
          charsetNumber: charsetNumber,
          currentConfig: this.config
        },
        err => {
          if (err) {
            err.fatal = true;
          }
          if (callback) {
            callback(err);
          }
        }
      )
    );
  }

  // transaction helpers
  beginTransaction(cb) {
    return this.query('START TRANSACTION', cb);
  }

  commit(cb) {
    return this.query('COMMIT', cb);
  }

  rollback(cb) {
    return this.query('ROLLBACK', cb);
  }

  ping(cb) {
    return this.addCommand(new Commands.Ping(cb));
  }

  _registerSlave(opts, cb) {
    return this.addCommand(new Commands.RegisterSlave(opts, cb));
  }

  _binlogDump(opts, cb) {
    return this.addCommand(new Commands.BinlogDump(opts, cb));
  }

  // currently just alias to close
  destroy() {
    this.close();
  }

  close() {
    if (this.connectTimeout) {
      Timers.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this._closing = true;
    this.stream.end();
    this.addCommand = this._addCommandClosedState;
  }

  createBinlogStream(opts) {
    // TODO: create proper stream class
    // TODO: use through2
    let test = 1;
    const stream = new Readable({ objectMode: true });
    stream._read = function() {
      return {
        data: test++
      };
    };
    this._registerSlave(opts, () => {
      const dumpCmd = this._binlogDump(opts);
      dumpCmd.on('event', ev => {
        stream.push(ev);
      });
      dumpCmd.on('eof', () => {
        stream.push(null);
        // if non-blocking, then close stream to prevent errors
        if (opts.flags && opts.flags & 0x01) {
          this.close();
        }
      });
      // TODO: pipe errors as well
    });
    return stream;
  }

  connect(cb) {
    if (!cb) {
      return;
    }
    if (this._fatalError || this._protocolError) {
      return cb(this._fatalError || this._protocolError);
    }
    if (this._handshakePacket) {
      return cb(null, this);
    }
    let connectCalled = 0;
    function callbackOnce(isErrorHandler) {
      return function(param) {
        if (!connectCalled) {
          if (isErrorHandler) {
            cb(param);
          } else {
            cb(null, param);
          }
        }
        connectCalled = 1;
      };
    }
    this.once('error', callbackOnce(true));
    this.once('connect', callbackOnce(false));
  }

  // ===================================
  // outgoing server connection methods
  // ===================================
  writeColumns(columns) {
    this.writePacket(Packets.ResultSetHeader.toPacket(columns.length));
    columns.forEach(column => {
      this.writePacket(
        Packets.ColumnDefinition.toPacket(column, this.serverConfig.encoding)
      );
    });
    this.writeEof();
  }

  // row is array of columns, not hash
  writeTextRow(column) {
    this.writePacket(
      Packets.TextRow.toPacket(column, this.serverConfig.encoding)
    );
  }

  writeTextResult(rows, columns) {
    this.writeColumns(columns);
    rows.forEach(row => {
      const arrayRow = new Array(columns.length);
      columns.forEach(column => {
        arrayRow.push(row[column.name]);
      });
      this.writeTextRow(arrayRow);
    });
    this.writeEof();
  }

  writeEof(warnings, statusFlags) {
    this.writePacket(Packets.EOF.toPacket(warnings, statusFlags));
  }

  writeOk(args) {
    if (!args) {
      args = { affectedRows: 0 };
    }
    this.writePacket(Packets.OK.toPacket(args, this.serverConfig.encoding));
  }

  writeError(args) {
    // if we want to send error before initial hello was sent, use default encoding
    const encoding = this.serverConfig ? this.serverConfig.encoding : 'cesu8';
    this.writePacket(Packets.Error.toPacket(args, encoding));
  }

  serverHandshake(args) {
    this.serverConfig = args;
    this.serverConfig.encoding =
      CharsetToEncoding[this.serverConfig.characterSet];
    return this.addCommand(new Commands.ServerHandshake(args));
  }

  // ===============================================================
  end(callback) {
    if (this.config.isServer) {
      this._closing = true;
      const quitCmd = new EventEmitter();
      setImmediate(() => {
        this.stream.end();
        quitCmd.emit('end');
      });
      return quitCmd;
    }
    // trigger error if more commands enqueued after end command
    const quitCmd = this.addCommand(new Commands.Quit(callback));
    this.addCommand = this._addCommandClosedState;
    return quitCmd;
  }

  static createQuery(sql, values, cb, config) {
    let options = {
      rowsAsArray: config.rowsAsArray
    };
    if (typeof sql === 'object') {
      // query(options, cb)
      options = sql;
      if (typeof values === 'function') {
        cb = values;
      } else if (values !== undefined) {
        options.values = values;
      }
    } else if (typeof values === 'function') {
      // query(sql, cb)
      cb = values;
      options.sql = sql;
      options.values = undefined;
    } else {
      // query(sql, values, cb)
      options.sql = sql;
      options.values = values;
    }
    return new Commands.Query(options, cb);
  }

  static statementKey(options) {
    return (
      `${typeof options.nestTables}/${options.nestTables}/${options.rowsAsArray}${options.sql}`
    );
  }
}

if (Tls.TLSSocket) {
  // not supported
} else {
  Connection.prototype.startTLS = function _startTLS(onSecure) {
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.log('Upgrading connection to TLS');
    }
    const crypto = require('crypto');
    const config = this.config;
    const stream = this.stream;
    const rejectUnauthorized = this.config.ssl.rejectUnauthorized;
    const credentials = crypto.createCredentials({
      key: config.ssl.key,
      cert: config.ssl.cert,
      passphrase: config.ssl.passphrase,
      ca: config.ssl.ca,
      ciphers: config.ssl.ciphers
    });
    const securePair = Tls.createSecurePair(
      credentials,
      false,
      true,
      rejectUnauthorized
    );

    if (stream.ondata) {
      stream.ondata = null;
    }
    stream.removeAllListeners('data');
    stream.pipe(securePair.encrypted);
    securePair.encrypted.pipe(stream);
    securePair.cleartext.on('data', data => {
      this.packetParser.execute(data);
    });
    this.write = function(buffer) {
      securePair.cleartext.write(buffer);
    };
    securePair.on('secure', () => {
      onSecure(rejectUnauthorized ? securePair.ssl.verifyError() : null);
    });
  };
}

module.exports = Connection;

}, function(modId) { var map = {"./packet_parser.js":1619928528774,"./packets/index.js":1619928528778,"./commands/index.js":1619928528806,"./connection_config.js":1619928528831,"./constants/charset_encodings.js":1619928528789,"../promise":1619928528833}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528774, function(require, module, exports) {


const Packet = require('./packets/packet.js');

const MAX_PACKET_LENGTH = 16777215;

function readPacketLength(b, off) {
  const b0 = b[off];
  const b1 = b[off + 1];
  const b2 = b[off + 2];
  if (b1 + b2 === 0) {
    return b0;
  }
  return b0 + (b1 << 8) + (b2 << 16);
}

class PacketParser {
  constructor(onPacket, packetHeaderLength) {
    // 4 for normal packets, 7 for comprssed protocol packets
    if (typeof packetHeaderLength === 'undefined') {
      packetHeaderLength = 4;
    }
    // array of last payload chunks
    // only used when current payload is not complete
    this.buffer = [];
    // total length of chunks on buffer
    this.bufferLength = 0;
    this.packetHeaderLength = packetHeaderLength;
    // incomplete header state: number of header bytes received
    this.headerLen = 0;
    // expected payload length
    this.length = 0;
    this.largePacketParts = [];
    this.firstPacketSequenceId = 0;
    this.onPacket = onPacket;
    this.execute = PacketParser.prototype.executeStart;
    this._flushLargePacket =
      packetHeaderLength === 7
        ? this._flushLargePacket7
        : this._flushLargePacket4;
  }

  _flushLargePacket4() {
    const numPackets = this.largePacketParts.length;
    this.largePacketParts.unshift(Buffer.from([0, 0, 0, 0])); // insert header
    const body = Buffer.concat(this.largePacketParts);
    const packet = new Packet(this.firstPacketSequenceId, body, 0, body.length);
    this.largePacketParts.length = 0;
    packet.numPackets = numPackets;
    this.onPacket(packet);
  }

  _flushLargePacket7() {
    const numPackets = this.largePacketParts.length;
    this.largePacketParts.unshift(Buffer.from([0, 0, 0, 0, 0, 0, 0])); // insert header
    const body = Buffer.concat(this.largePacketParts);
    this.largePacketParts.length = 0;
    const packet = new Packet(this.firstPacketSequenceId, body, 0, body.length);
    packet.numPackets = numPackets;
    this.onPacket(packet);
  }

  executeStart(chunk) {
    let start = 0;
    const end = chunk.length;
    while (end - start >= 3) {
      this.length = readPacketLength(chunk, start);
      if (end - start >= this.length + this.packetHeaderLength) {
        // at least one full packet
        const sequenceId = chunk[start + 3];
        if (
          this.length < MAX_PACKET_LENGTH &&
          this.largePacketParts.length === 0
        ) {
          this.onPacket(
            new Packet(
              sequenceId,
              chunk,
              start,
              start + this.packetHeaderLength + this.length
            )
          );
        } else {
          // first large packet - remember it's id
          if (this.largePacketParts.length === 0) {
            this.firstPacketSequenceId = sequenceId;
          }
          this.largePacketParts.push(
            chunk.slice(
              start + this.packetHeaderLength,
              start + this.packetHeaderLength + this.length
            )
          );
          if (this.length < MAX_PACKET_LENGTH) {
            this._flushLargePacket();
          }
        }
        start += this.packetHeaderLength + this.length;
      } else {
        // payload is incomplete
        this.buffer = [chunk.slice(start + 3, end)];
        this.bufferLength = end - start - 3;
        this.execute = PacketParser.prototype.executePayload;
        return;
      }
    }
    if (end - start > 0) {
      // there is start of length header, but it's not full 3 bytes
      this.headerLen = end - start; // 1 or 2 bytes
      this.length = chunk[start];
      if (this.headerLen === 2) {
        this.length = chunk[start] + (chunk[start + 1] << 8);
        this.execute = PacketParser.prototype.executeHeader3;
      } else {
        this.execute = PacketParser.prototype.executeHeader2;
      }
    }
  }

  executePayload(chunk) {
    let start = 0;
    const end = chunk.length;
    const remainingPayload =
      this.length - this.bufferLength + this.packetHeaderLength - 3;
    if (end - start >= remainingPayload) {
      // last chunk for payload
      const payload = Buffer.allocUnsafe(this.length + this.packetHeaderLength);
      let offset = 3;
      for (let i = 0; i < this.buffer.length; ++i) {
        this.buffer[i].copy(payload, offset);
        offset += this.buffer[i].length;
      }
      chunk.copy(payload, offset, start, start + remainingPayload);
      const sequenceId = payload[3];
      if (
        this.length < MAX_PACKET_LENGTH &&
        this.largePacketParts.length === 0
      ) {
        this.onPacket(
          new Packet(
            sequenceId,
            payload,
            0,
            this.length + this.packetHeaderLength
          )
        );
      } else {
        // first large packet - remember it's id
        if (this.largePacketParts.length === 0) {
          this.firstPacketSequenceId = sequenceId;
        }
        this.largePacketParts.push(
          payload.slice(
            this.packetHeaderLength,
            this.packetHeaderLength + this.length
          )
        );
        if (this.length < MAX_PACKET_LENGTH) {
          this._flushLargePacket();
        }
      }
      this.buffer = [];
      this.bufferLength = 0;
      this.execute = PacketParser.prototype.executeStart;
      start += remainingPayload;
      if (end - start > 0) {
        return this.execute(chunk.slice(start, end));
      }
    } else {
      this.buffer.push(chunk);
      this.bufferLength += chunk.length;
    }
    return null;
  }

  executeHeader2(chunk) {
    this.length += chunk[0] << 8;
    if (chunk.length > 1) {
      this.length += chunk[1] << 16;
      this.execute = PacketParser.prototype.executePayload;
      return this.executePayload(chunk.slice(2));
    } 
    this.execute = PacketParser.prototype.executeHeader3;
    
    return null;
  }

  executeHeader3(chunk) {
    this.length += chunk[0] << 16;
    this.execute = PacketParser.prototype.executePayload;
    return this.executePayload(chunk.slice(1));
  }
}

module.exports = PacketParser;

}, function(modId) { var map = {"./packets/packet.js":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528775, function(require, module, exports) {


const ErrorCodeToName = require('../constants/errors.js');
const NativeBuffer = require('buffer').Buffer;
const Long = require('long');
const StringParser = require('../parsers/string.js');

const INVALID_DATE = new Date(NaN);

// this is nearly duplicate of previous function so generated code is not slower
// due to "if (dateStrings)" branching
const pad = '000000000000';
function leftPad(num, value) {
  const s = value.toString();
  // if we don't need to pad
  if (s.length >= num) {
    return s;
  }
  return (pad + s).slice(-num);
}

// The whole reason parse* function below exist
// is because String creation is relatively expensive (at least with V8), and if we have
// a buffer with "12345" content ideally we would like to bypass intermediate
// "12345" string creation and directly build 12345 number out of
// <Buffer 31 32 33 34 35> data.
// In my benchmarks the difference is ~25M 8-digit numbers per second vs
// 4.5 M using Number(packet.readLengthCodedString())
// not used when size is close to max precision as series of *10 accumulate error
// and approximate result mihgt be diffreent from (approximate as well) Number(bigNumStringValue))
// In the futire node version if speed difference is smaller parse* functions might be removed
// don't consider them as Packet public API

const minus = '-'.charCodeAt(0);
const plus = '+'.charCodeAt(0);

// TODO: handle E notation
const dot = '.'.charCodeAt(0);
const exponent = 'e'.charCodeAt(0);
const exponentCapital = 'E'.charCodeAt(0);

class Packet {
  constructor(id, buffer, start, end) {
    // hot path, enable checks when testing only
    // if (!Buffer.isBuffer(buffer) || typeof start == 'undefined' || typeof end == 'undefined')
    //  throw new Error('invalid packet');
    this.sequenceId = id;
    this.numPackets = 1;
    this.buffer = buffer;
    this.start = start;
    this.offset = start + 4;
    this.end = end;
  }

  // ==============================
  // readers
  // ==============================
  reset() {
    this.offset = this.start + 4;
  }

  length() {
    return this.end - this.start;
  }

  slice() {
    return this.buffer.slice(this.start, this.end);
  }

  dump() {
    // eslint-disable-next-line no-console
    console.log(
      [this.buffer.asciiSlice(this.start, this.end)],
      this.buffer.slice(this.start, this.end),
      this.length(),
      this.sequenceId
    );
  }

  haveMoreData() {
    return this.end > this.offset;
  }

  skip(num) {
    this.offset += num;
  }

  readInt8() {
    return this.buffer[this.offset++];
  }

  readInt16() {
    this.offset += 2;
    return this.buffer.readUInt16LE(this.offset - 2);
  }

  readInt24() {
    return this.readInt16() + (this.readInt8() << 16);
  }

  readInt32() {
    this.offset += 4;
    return this.buffer.readUInt32LE(this.offset - 4);
  }

  readSInt8() {
    return this.buffer.readInt8(this.offset++);
  }

  readSInt16() {
    this.offset += 2;
    return this.buffer.readInt16LE(this.offset - 2);
  }

  readSInt32() {
    this.offset += 4;
    return this.buffer.readInt32LE(this.offset - 4);
  }

  readInt64JSNumber() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    const l = new Long(word0, word1, true);
    return l.toNumber();
  }

  readSInt64JSNumber() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    if (!(word1 & 0x80000000)) {
      return word0 + 0x100000000 * word1;
    }
    const l = new Long(word0, word1, false);
    return l.toNumber();
  }

  readInt64String() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    const res = new Long(word0, word1, true);
    return res.toString();
  }

  readSInt64String() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    const res = new Long(word0, word1, false);
    return res.toString();
  }

  readInt64() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    let res = new Long(word0, word1, true);
    const resNumber = res.toNumber();
    const resString = res.toString();
    res = resNumber.toString() === resString ? resNumber : resString;
    return res;
  }

  readSInt64() {
    const word0 = this.readInt32();
    const word1 = this.readInt32();
    let res = new Long(word0, word1, false);
    const resNumber = res.toNumber();
    const resString = res.toString();
    res = resNumber.toString() === resString ? resNumber : resString;
    return res;
  }

  isEOF() {
    return this.buffer[this.offset] === 0xfe && this.length() < 13;
  }

  eofStatusFlags() {
    return this.buffer.readInt16LE(this.offset + 3);
  }

  eofWarningCount() {
    return this.buffer.readInt16LE(this.offset + 1);
  }

  readLengthCodedNumber(bigNumberStrings, signed) {
    const byte1 = this.buffer[this.offset++];
    if (byte1 < 251) {
      return byte1;
    }
    return this.readLengthCodedNumberExt(byte1, bigNumberStrings, signed);
  }

  readLengthCodedNumberSigned(bigNumberStrings) {
    return this.readLengthCodedNumber(bigNumberStrings, true);
  }

  readLengthCodedNumberExt(tag, bigNumberStrings, signed) {
    let word0, word1;
    let res;
    if (tag === 0xfb) {
      return null;
    }
    if (tag === 0xfc) {
      return this.readInt8() + (this.readInt8() << 8);
    }
    if (tag === 0xfd) {
      return this.readInt8() + (this.readInt8() << 8) + (this.readInt8() << 16);
    }
    if (tag === 0xfe) {
      // TODO: check version
      // Up to MySQL 3.22, 0xfe was followed by a 4-byte integer.
      word0 = this.readInt32();
      word1 = this.readInt32();
      if (word1 === 0) {
        return word0; // don't convert to float if possible
      }
      if (word1 < 2097152) {
        // max exact float point int, 2^52 / 2^32
        return word1 * 0x100000000 + word0;
      }
      res = new Long(word0, word1, !signed); // Long need unsigned
      const resNumber = res.toNumber();
      const resString = res.toString();
      res = resNumber.toString() === resString ? resNumber : resString;
      return bigNumberStrings ? resString : res;
    }
    // eslint-disable-next-line no-console
    console.trace();
    throw new Error(`Should not reach here: ${tag}`);
  }

  readFloat() {
    const res = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return res;
  }

  readDouble() {
    const res = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return res;
  }

  readBuffer(len) {
    if (typeof len === 'undefined') {
      len = this.end - this.offset;
    }
    this.offset += len;
    return this.buffer.slice(this.offset - len, this.offset);
  }

  // DATE, DATETIME and TIMESTAMP
  readDateTime(timezone) {
    if (!timezone || timezone === 'Z' || timezone === 'local') {
      const length = this.readInt8();
      if (length === 0xfb) {
        return null;
      }
      let y = 0;
      let m = 0;
      let d = 0;
      let H = 0;
      let M = 0;
      let S = 0;
      let ms = 0;
      if (length > 3) {
        y = this.readInt16();
        m = this.readInt8();
        d = this.readInt8();
      }
      if (length > 6) {
        H = this.readInt8();
        M = this.readInt8();
        S = this.readInt8();
      }
      if (length > 10) {
        ms = this.readInt32() / 1000;
      }
      if (y + m + d + H + M + S + ms === 0) {
        return INVALID_DATE;
      }
      if (timezone === 'Z') {
        return new Date(Date.UTC(y, m - 1, d, H, M, S, ms));
      }
      return new Date(y, m - 1, d, H, M, S, ms);
    }
    let str = this.readDateTimeString(6, 'T');
    if (str.length === 10) {
      str += 'T00:00:00';
    }
    return new Date(str + timezone);
  }

  readDateTimeString(decimals, timeSep) {
    const length = this.readInt8();
    let y = 0;
    let m = 0;
    let d = 0;
    let H = 0;
    let M = 0;
    let S = 0;
    let ms = 0;
    let str;
    if (length > 3) {
      y = this.readInt16();
      m = this.readInt8();
      d = this.readInt8();
      str = [leftPad(4, y), leftPad(2, m), leftPad(2, d)].join('-');
    }
    if (length > 6) {
      H = this.readInt8();
      M = this.readInt8();
      S = this.readInt8();
      str += `${timeSep || ' '}${[
        leftPad(2, H),
        leftPad(2, M),
        leftPad(2, S)
      ].join(':')}`;
    }
    if (length > 10) {
      ms = this.readInt32();
      str += '.';
      if (decimals) {
        ms = leftPad(6, ms);
        if (ms.length > decimals) {
          ms = ms.substring(0, decimals); // rounding is done at the MySQL side, only 0 are here
        }
      }
      str += ms;
    }
    return str;
  }

  // TIME - value as a string, Can be negative
  readTimeString(convertTtoMs) {
    const length = this.readInt8();
    if (length === 0) {
      return '00:00:00';
    }
    const sign = this.readInt8() ? -1 : 1; // 'isNegative' flag byte
    let d = 0;
    let H = 0;
    let M = 0;
    let S = 0;
    let ms = 0;
    if (length > 6) {
      d = this.readInt32();
      H = this.readInt8();
      M = this.readInt8();
      S = this.readInt8();
    }
    if (length > 10) {
      ms = this.readInt32();
    }
    if (convertTtoMs) {
      H += d * 24;
      M += H * 60;
      S += M * 60;
      ms += S * 1000;
      ms *= sign;
      return ms;
    }
    return (
      (sign === -1 ? '-' : '') +
      [d ? d * 24 + H : H, leftPad(2, M), leftPad(2, S)].join(':') +
      (ms ? `.${ms}` : '')
    );
  }

  readLengthCodedString(encoding) {
    const len = this.readLengthCodedNumber();
    // TODO: check manually first byte here to avoid polymorphic return type?
    if (len === null) {
      return null;
    }
    this.offset += len;
    // TODO: Use characterSetCode to get proper encoding
    // https://github.com/sidorares/node-mysql2/pull/374
    return StringParser.decode(
      this.buffer.slice(this.offset - len, this.offset),
      encoding
    );
  }

  readLengthCodedBuffer() {
    const len = this.readLengthCodedNumber();
    if (len === null) {
      return null;
    }
    return this.readBuffer(len);
  }

  readNullTerminatedString(encoding) {
    const start = this.offset;
    let end = this.offset;
    while (this.buffer[end]) {
      end = end + 1; // TODO: handle OOB check
    }
    this.offset = end + 1;
    return StringParser.decode(this.buffer.slice(start, end), encoding);
  }

  // TODO reuse?
  readString(len, encoding) {
    if ((typeof len === 'string') && (typeof encoding === 'undefined')) {
      encoding = len
      len = undefined
    }
    if (typeof len === 'undefined') {
      len = this.end - this.offset;
    }
    this.offset += len;
    return StringParser.decode(
      this.buffer.slice(this.offset - len, this.offset),
      encoding
    );
  }

  parseInt(len, supportBigNumbers) {
    if (len === null) {
      return null;
    }
    if (len >= 14 && !supportBigNumbers) {
      const s = this.buffer.toString('ascii', this.offset, this.offset + len);
      this.offset += len;
      return Number(s);
    }
    let result = 0;
    const start = this.offset;
    const end = this.offset + len;
    let sign = 1;
    if (len === 0) {
      return 0; // TODO: assert? exception?
    }
    if (this.buffer[this.offset] === minus) {
      this.offset++;
      sign = -1;
    }
    // max precise int is 9007199254740992
    let str;
    const numDigits = end - this.offset;
    if (supportBigNumbers) {
      if (numDigits >= 15) {
        str = this.readString(end - this.offset, 'binary');
        result = parseInt(str, 10);
        if (result.toString() === str) {
          return sign * result;
        }
        return sign === -1 ? `-${str}` : str;
      }
      if (numDigits > 16) {
        str = this.readString(end - this.offset);
        return sign === -1 ? `-${str}` : str;
      }
    }
    if (this.buffer[this.offset] === plus) {
      this.offset++; // just ignore
    }
    while (this.offset < end) {
      result *= 10;
      result += this.buffer[this.offset] - 48;
      this.offset++;
    }
    const num = result * sign;
    if (!supportBigNumbers) {
      return num;
    }
    str = this.buffer.toString('ascii', start, end);
    if (num.toString() === str) {
      return num;
    }
    return str;
  }

  // note that if value of inputNumberAsString is bigger than MAX_SAFE_INTEGER
  // ( or smaller than MIN_SAFE_INTEGER ) the parseIntNoBigCheck result might be
  // different from what you would get from Number(inputNumberAsString)
  // String(parseIntNoBigCheck) <> String(Number(inputNumberAsString)) <> inputNumberAsString
  parseIntNoBigCheck(len) {
    if (len === null) {
      return null;
    }
    let result = 0;
    const end = this.offset + len;
    let sign = 1;
    if (len === 0) {
      return 0; // TODO: assert? exception?
    }
    if (this.buffer[this.offset] === minus) {
      this.offset++;
      sign = -1;
    }
    if (this.buffer[this.offset] === plus) {
      this.offset++; // just ignore
    }
    while (this.offset < end) {
      result *= 10;
      result += this.buffer[this.offset] - 48;
      this.offset++;
    }
    return result * sign;
  }

  // copy-paste from https://github.com/mysqljs/mysql/blob/master/lib/protocol/Parser.js
  parseGeometryValue() {
    const buffer = this.readLengthCodedBuffer();
    let offset = 4;
    if (buffer === null || !buffer.length) {
      return null;
    }
    function parseGeometry() {
      let x, y, i, j, numPoints, line;
      let result = null;
      const byteOrder = buffer.readUInt8(offset);
      offset += 1;
      const wkbType = byteOrder
        ? buffer.readUInt32LE(offset)
        : buffer.readUInt32BE(offset);
      offset += 4;
      switch (wkbType) {
        case 1: // WKBPoint
          x = byteOrder
            ? buffer.readDoubleLE(offset)
            : buffer.readDoubleBE(offset);
          offset += 8;
          y = byteOrder
            ? buffer.readDoubleLE(offset)
            : buffer.readDoubleBE(offset);
          offset += 8;
          result = { x: x, y: y };
          break;
        case 2: // WKBLineString
          numPoints = byteOrder
            ? buffer.readUInt32LE(offset)
            : buffer.readUInt32BE(offset);
          offset += 4;
          result = [];
          for (i = numPoints; i > 0; i--) {
            x = byteOrder
              ? buffer.readDoubleLE(offset)
              : buffer.readDoubleBE(offset);
            offset += 8;
            y = byteOrder
              ? buffer.readDoubleLE(offset)
              : buffer.readDoubleBE(offset);
            offset += 8;
            result.push({ x: x, y: y });
          }
          break;
        case 3: // WKBPolygon
          // eslint-disable-next-line no-case-declarations
          const numRings = byteOrder
            ? buffer.readUInt32LE(offset)
            : buffer.readUInt32BE(offset);
          offset += 4;
          result = [];
          for (i = numRings; i > 0; i--) {
            numPoints = byteOrder
              ? buffer.readUInt32LE(offset)
              : buffer.readUInt32BE(offset);
            offset += 4;
            line = [];
            for (j = numPoints; j > 0; j--) {
              x = byteOrder
                ? buffer.readDoubleLE(offset)
                : buffer.readDoubleBE(offset);
              offset += 8;
              y = byteOrder
                ? buffer.readDoubleLE(offset)
                : buffer.readDoubleBE(offset);
              offset += 8;
              line.push({ x: x, y: y });
            }
            result.push(line);
          }
          break;
        case 4: // WKBMultiPoint
        case 5: // WKBMultiLineString
        case 6: // WKBMultiPolygon
        case 7: // WKBGeometryCollection
          // eslint-disable-next-line no-case-declarations
          const num = byteOrder
            ? buffer.readUInt32LE(offset)
            : buffer.readUInt32BE(offset);
          offset += 4;
          result = [];
          for (i = num; i > 0; i--) {
            result.push(parseGeometry());
          }
          break;
      }
      return result;
    }
    return parseGeometry();
  }

  parseDate(timezone) {
    const strLen = this.readLengthCodedNumber();
    if (strLen === null) {
      return null;
    }
    if (strLen !== 10) {
      // we expect only YYYY-MM-DD here.
      // if for some reason it's not the case return invalid date
      return new Date(NaN);
    }
    const y = this.parseInt(4);
    this.offset++; // -
    const m = this.parseInt(2);
    this.offset++; // -
    const d = this.parseInt(2);
    if (!timezone || timezone === 'local') {
      return new Date(y, m - 1, d);
    }
    if (timezone === 'Z') {
      return new Date(Date.UTC(y, m - 1, d));
    }
    return new Date(
      `${leftPad(4, y)}-${leftPad(2, m)}-${leftPad(2, d)}T00:00:00${timezone}`
    );
  }

  parseDateTime(timezone) {
    const str = this.readLengthCodedString('binary');
    if (str === null) {
      return null;
    }
    if (!timezone || timezone === 'local') {
      return new Date(str);
    }
    return new Date(`${str}${timezone}`);
  }

  parseFloat(len) {
    if (len === null) {
      return null;
    }
    let result = 0;
    const end = this.offset + len;
    let factor = 1;
    let pastDot = false;
    let charCode = 0;
    if (len === 0) {
      return 0; // TODO: assert? exception?
    }
    if (this.buffer[this.offset] === minus) {
      this.offset++;
      factor = -1;
    }
    if (this.buffer[this.offset] === plus) {
      this.offset++; // just ignore
    }
    while (this.offset < end) {
      charCode = this.buffer[this.offset];
      if (charCode === dot) {
        pastDot = true;
        this.offset++;
      } else if (charCode === exponent || charCode === exponentCapital) {
        this.offset++;
        const exponentValue = this.parseInt(end - this.offset);
        return (result / factor) * Math.pow(10, exponentValue);
      } else {
        result *= 10;
        result += this.buffer[this.offset] - 48;
        this.offset++;
        if (pastDot) {
          factor = factor * 10;
        }
      }
    }
    return result / factor;
  }

  parseLengthCodedIntNoBigCheck() {
    return this.parseIntNoBigCheck(this.readLengthCodedNumber());
  }

  parseLengthCodedInt(supportBigNumbers) {
    return this.parseInt(this.readLengthCodedNumber(), supportBigNumbers);
  }

  parseLengthCodedIntString() {
    return this.readLengthCodedString('binary');
  }

  parseLengthCodedFloat() {
    return this.parseFloat(this.readLengthCodedNumber());
  }

  peekByte() {
    return this.buffer[this.offset];
  }

  // OxFE is often used as "Alt" flag - not ok, not error.
  // For example, it's first byte of AuthSwitchRequest
  isAlt() {
    return this.peekByte() === 0xfe;
  }

  isError() {
    return this.peekByte() === 0xff;
  }

  asError(encoding) {
    this.reset();
    this.readInt8(); // fieldCount
    const errorCode = this.readInt16();
    let sqlState = '';
    if (this.buffer[this.offset] === 0x23) {
      this.skip(1);
      sqlState = this.readBuffer(5).toString();
    }
    const message = this.readString(undefined, encoding);
    const err = new Error(message);
    err.code = ErrorCodeToName[errorCode];
    err.errno = errorCode;
    err.sqlState = sqlState;
    err.sqlMessage = message;
    return err;
  }

  writeInt32(n) {
    this.buffer.writeUInt32LE(n, this.offset);
    this.offset += 4;
  }

  writeInt24(n) {
    this.writeInt8(n & 0xff);
    this.writeInt16(n >> 8);
  }

  writeInt16(n) {
    this.buffer.writeUInt16LE(n, this.offset);
    this.offset += 2;
  }

  writeInt8(n) {
    this.buffer.writeUInt8(n, this.offset);
    this.offset++;
  }

  writeDouble(n) {
    this.buffer.writeDoubleLE(n, this.offset);
    this.offset += 8;
  }

  writeBuffer(b) {
    b.copy(this.buffer, this.offset);
    this.offset += b.length;
  }

  writeNull() {
    this.buffer[this.offset] = 0xfb;
    this.offset++;
  }

  // TODO: refactor following three?
  writeNullTerminatedString(s, encoding) {
    const buf = StringParser.encode(s, encoding);
    this.buffer.length && buf.copy(this.buffer, this.offset);
    this.offset += buf.length;
    this.writeInt8(0);
  }

  writeString(s, encoding) {
    if (s === null) {
      this.writeInt8(0xfb);
      return;
    }
    if (s.length === 0) {
      return;
    }
    // const bytes = Buffer.byteLength(s, 'utf8');
    // this.buffer.write(s, this.offset, bytes, 'utf8');
    // this.offset += bytes;
    const buf = StringParser.encode(s, encoding);
    this.buffer.length && buf.copy(this.buffer, this.offset);
    this.offset += buf.length;
  }

  writeLengthCodedString(s, encoding) {
    const buf = StringParser.encode(s, encoding);
    this.writeLengthCodedNumber(buf.length);
    this.buffer.length && buf.copy(this.buffer, this.offset);
    this.offset += buf.length;
  }

  writeLengthCodedBuffer(b) {
    this.writeLengthCodedNumber(b.length);
    b.copy(this.buffer, this.offset);
    this.offset += b.length;
  }

  writeLengthCodedNumber(n) {
    if (n < 0xfb) {
      return this.writeInt8(n);
    }
    if (n < 0xffff) {
      this.writeInt8(0xfc);
      return this.writeInt16(n);
    }
    if (n < 0xffffff) {
      this.writeInt8(0xfd);
      return this.writeInt24(n);
    }
    if (n === null) {
      return this.writeInt8(0xfb);
    }
    // TODO: check that n is out of int precision
    this.writeInt8(0xfe);
    this.buffer.writeUInt32LE(n, this.offset);
    this.offset += 4;
    this.buffer.writeUInt32LE(n >> 32, this.offset);
    this.offset += 4;
    return this.offset;
  }

  writeDate(d, timezone) {
    this.buffer.writeUInt8(11, this.offset);
    if (!timezone || timezone === 'local') {
      this.buffer.writeUInt16LE(d.getFullYear(), this.offset + 1);
      this.buffer.writeUInt8(d.getMonth() + 1, this.offset + 3);
      this.buffer.writeUInt8(d.getDate(), this.offset + 4);
      this.buffer.writeUInt8(d.getHours(), this.offset + 5);
      this.buffer.writeUInt8(d.getMinutes(), this.offset + 6);
      this.buffer.writeUInt8(d.getSeconds(), this.offset + 7);
      this.buffer.writeUInt32LE(d.getMilliseconds() * 1000, this.offset + 8);
    } else {
      if (timezone !== 'Z') {
        const offset =
          (timezone[0] === '-' ? -1 : 1) *
          (parseInt(timezone.substring(1, 3), 10) * 60 +
            parseInt(timezone.substring(4), 10));
        if (offset !== 0) {
          d = new Date(d.getTime() + 60000 * offset);
        }
      }
      this.buffer.writeUInt16LE(d.getUTCFullYear(), this.offset + 1);
      this.buffer.writeUInt8(d.getUTCMonth() + 1, this.offset + 3);
      this.buffer.writeUInt8(d.getUTCDate(), this.offset + 4);
      this.buffer.writeUInt8(d.getUTCHours(), this.offset + 5);
      this.buffer.writeUInt8(d.getUTCMinutes(), this.offset + 6);
      this.buffer.writeUInt8(d.getUTCSeconds(), this.offset + 7);
      this.buffer.writeUInt32LE(d.getUTCMilliseconds() * 1000, this.offset + 8);
    }
    this.offset += 12;
  }

  writeHeader(sequenceId) {
    const offset = this.offset;
    this.offset = 0;
    this.writeInt24(this.buffer.length - 4);
    this.writeInt8(sequenceId);
    this.offset = offset;
  }

  clone() {
    return new Packet(this.sequenceId, this.buffer, this.start, this.end);
  }

  type() {
    if (this.isEOF()) {
      return 'EOF';
    }
    if (this.isError()) {
      return 'Error';
    }
    if (this.buffer[this.offset] === 0) {
      return 'maybeOK'; // could be other packet types as well
    }
    return '';
  }

  static lengthCodedNumberLength(n) {
    if (n < 0xfb) {
      return 1;
    }
    if (n < 0xffff) {
      return 3;
    }
    if (n < 0xffffff) {
      return 5;
    }
    return 9;
  }

  static lengthCodedStringLength(str, encoding) {
    const buf = StringParser.encode(str, encoding);
    const slen = buf.length;
    return Packet.lengthCodedNumberLength(slen) + slen;
  }

  static MockBuffer() {
    const noop = function() {};
    const res = Buffer.alloc(0);
    for (const op in NativeBuffer.prototype) {
      if (typeof res[op] === 'function') {
        res[op] = noop;
      }
    }
    return res;
  }
}

module.exports = Packet;

}, function(modId) { var map = {"../constants/errors.js":1619928528776,"../parsers/string.js":1619928528777}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528776, function(require, module, exports) {


// copy from https://raw.githubusercontent.com/mysqljs/mysql/7770ee5bb13260c56a160b91fe480d9165dbeeba/lib/protocol/constants/errors.js
// (c) node-mysql authors

/**
 * MySQL error constants
 *
 * !! Generated by generate-error-constants.js, do not modify by hand !!
 */

exports.EE_CANTCREATEFILE = 1;
exports.EE_READ = 2;
exports.EE_WRITE = 3;
exports.EE_BADCLOSE = 4;
exports.EE_OUTOFMEMORY = 5;
exports.EE_DELETE = 6;
exports.EE_LINK = 7;
exports.EE_EOFERR = 9;
exports.EE_CANTLOCK = 10;
exports.EE_CANTUNLOCK = 11;
exports.EE_DIR = 12;
exports.EE_STAT = 13;
exports.EE_CANT_CHSIZE = 14;
exports.EE_CANT_OPEN_STREAM = 15;
exports.EE_GETWD = 16;
exports.EE_SETWD = 17;
exports.EE_LINK_WARNING = 18;
exports.EE_OPEN_WARNING = 19;
exports.EE_DISK_FULL = 20;
exports.EE_CANT_MKDIR = 21;
exports.EE_UNKNOWN_CHARSET = 22;
exports.EE_OUT_OF_FILERESOURCES = 23;
exports.EE_CANT_READLINK = 24;
exports.EE_CANT_SYMLINK = 25;
exports.EE_REALPATH = 26;
exports.EE_SYNC = 27;
exports.EE_UNKNOWN_COLLATION = 28;
exports.EE_FILENOTFOUND = 29;
exports.EE_FILE_NOT_CLOSED = 30;
exports.EE_CHANGE_OWNERSHIP = 31;
exports.EE_CHANGE_PERMISSIONS = 32;
exports.EE_CANT_SEEK = 33;
exports.HA_ERR_KEY_NOT_FOUND = 120;
exports.HA_ERR_FOUND_DUPP_KEY = 121;
exports.HA_ERR_INTERNAL_ERROR = 122;
exports.HA_ERR_RECORD_CHANGED = 123;
exports.HA_ERR_WRONG_INDEX = 124;
exports.HA_ERR_CRASHED = 126;
exports.HA_ERR_WRONG_IN_RECORD = 127;
exports.HA_ERR_OUT_OF_MEM = 128;
exports.HA_ERR_NOT_A_TABLE = 130;
exports.HA_ERR_WRONG_COMMAND = 131;
exports.HA_ERR_OLD_FILE = 132;
exports.HA_ERR_NO_ACTIVE_RECORD = 133;
exports.HA_ERR_RECORD_DELETED = 134;
exports.HA_ERR_RECORD_FILE_FULL = 135;
exports.HA_ERR_INDEX_FILE_FULL = 136;
exports.HA_ERR_END_OF_FILE = 137;
exports.HA_ERR_UNSUPPORTED = 138;
exports.HA_ERR_TO_BIG_ROW = 139;
exports.HA_WRONG_CREATE_OPTION = 140;
exports.HA_ERR_FOUND_DUPP_UNIQUE = 141;
exports.HA_ERR_UNKNOWN_CHARSET = 142;
exports.HA_ERR_WRONG_MRG_TABLE_DEF = 143;
exports.HA_ERR_CRASHED_ON_REPAIR = 144;
exports.HA_ERR_CRASHED_ON_USAGE = 145;
exports.HA_ERR_LOCK_WAIT_TIMEOUT = 146;
exports.HA_ERR_LOCK_TABLE_FULL = 147;
exports.HA_ERR_READ_ONLY_TRANSACTION = 148;
exports.HA_ERR_LOCK_DEADLOCK = 149;
exports.HA_ERR_CANNOT_ADD_FOREIGN = 150;
exports.HA_ERR_NO_REFERENCED_ROW = 151;
exports.HA_ERR_ROW_IS_REFERENCED = 152;
exports.HA_ERR_NO_SAVEPOINT = 153;
exports.HA_ERR_NON_UNIQUE_BLOCK_SIZE = 154;
exports.HA_ERR_NO_SUCH_TABLE = 155;
exports.HA_ERR_TABLE_EXIST = 156;
exports.HA_ERR_NO_CONNECTION = 157;
exports.HA_ERR_NULL_IN_SPATIAL = 158;
exports.HA_ERR_TABLE_DEF_CHANGED = 159;
exports.HA_ERR_NO_PARTITION_FOUND = 160;
exports.HA_ERR_RBR_LOGGING_FAILED = 161;
exports.HA_ERR_DROP_INDEX_FK = 162;
exports.HA_ERR_FOREIGN_DUPLICATE_KEY = 163;
exports.HA_ERR_TABLE_NEEDS_UPGRADE = 164;
exports.HA_ERR_TABLE_READONLY = 165;
exports.HA_ERR_AUTOINC_READ_FAILED = 166;
exports.HA_ERR_AUTOINC_ERANGE = 167;
exports.HA_ERR_GENERIC = 168;
exports.HA_ERR_RECORD_IS_THE_SAME = 169;
exports.HA_ERR_LOGGING_IMPOSSIBLE = 170;
exports.HA_ERR_CORRUPT_EVENT = 171;
exports.HA_ERR_NEW_FILE = 172;
exports.HA_ERR_ROWS_EVENT_APPLY = 173;
exports.HA_ERR_INITIALIZATION = 174;
exports.HA_ERR_FILE_TOO_SHORT = 175;
exports.HA_ERR_WRONG_CRC = 176;
exports.HA_ERR_TOO_MANY_CONCURRENT_TRXS = 177;
exports.HA_ERR_NOT_IN_LOCK_PARTITIONS = 178;
exports.HA_ERR_INDEX_COL_TOO_LONG = 179;
exports.HA_ERR_INDEX_CORRUPT = 180;
exports.HA_ERR_UNDO_REC_TOO_BIG = 181;
exports.HA_FTS_INVALID_DOCID = 182;
exports.HA_ERR_TABLE_IN_FK_CHECK = 183;
exports.HA_ERR_TABLESPACE_EXISTS = 184;
exports.HA_ERR_TOO_MANY_FIELDS = 185;
exports.HA_ERR_ROW_IN_WRONG_PARTITION = 186;
exports.HA_ERR_INNODB_READ_ONLY = 187;
exports.HA_ERR_FTS_EXCEED_RESULT_CACHE_LIMIT = 188;
exports.HA_ERR_TEMP_FILE_WRITE_FAILURE = 189;
exports.HA_ERR_INNODB_FORCED_RECOVERY = 190;
exports.HA_ERR_FTS_TOO_MANY_WORDS_IN_PHRASE = 191;
exports.ER_HASHCHK = 1000;
exports.ER_NISAMCHK = 1001;
exports.ER_NO = 1002;
exports.ER_YES = 1003;
exports.ER_CANT_CREATE_FILE = 1004;
exports.ER_CANT_CREATE_TABLE = 1005;
exports.ER_CANT_CREATE_DB = 1006;
exports.ER_DB_CREATE_EXISTS = 1007;
exports.ER_DB_DROP_EXISTS = 1008;
exports.ER_DB_DROP_DELETE = 1009;
exports.ER_DB_DROP_RMDIR = 1010;
exports.ER_CANT_DELETE_FILE = 1011;
exports.ER_CANT_FIND_SYSTEM_REC = 1012;
exports.ER_CANT_GET_STAT = 1013;
exports.ER_CANT_GET_WD = 1014;
exports.ER_CANT_LOCK = 1015;
exports.ER_CANT_OPEN_FILE = 1016;
exports.ER_FILE_NOT_FOUND = 1017;
exports.ER_CANT_READ_DIR = 1018;
exports.ER_CANT_SET_WD = 1019;
exports.ER_CHECKREAD = 1020;
exports.ER_DISK_FULL = 1021;
exports.ER_DUP_KEY = 1022;
exports.ER_ERROR_ON_CLOSE = 1023;
exports.ER_ERROR_ON_READ = 1024;
exports.ER_ERROR_ON_RENAME = 1025;
exports.ER_ERROR_ON_WRITE = 1026;
exports.ER_FILE_USED = 1027;
exports.ER_FILSORT_ABORT = 1028;
exports.ER_FORM_NOT_FOUND = 1029;
exports.ER_GET_ERRNO = 1030;
exports.ER_ILLEGAL_HA = 1031;
exports.ER_KEY_NOT_FOUND = 1032;
exports.ER_NOT_FORM_FILE = 1033;
exports.ER_NOT_KEYFILE = 1034;
exports.ER_OLD_KEYFILE = 1035;
exports.ER_OPEN_AS_READONLY = 1036;
exports.ER_OUTOFMEMORY = 1037;
exports.ER_OUT_OF_SORTMEMORY = 1038;
exports.ER_UNEXPECTED_EOF = 1039;
exports.ER_CON_COUNT_ERROR = 1040;
exports.ER_OUT_OF_RESOURCES = 1041;
exports.ER_BAD_HOST_ERROR = 1042;
exports.ER_HANDSHAKE_ERROR = 1043;
exports.ER_DBACCESS_DENIED_ERROR = 1044;
exports.ER_ACCESS_DENIED_ERROR = 1045;
exports.ER_NO_DB_ERROR = 1046;
exports.ER_UNKNOWN_COM_ERROR = 1047;
exports.ER_BAD_NULL_ERROR = 1048;
exports.ER_BAD_DB_ERROR = 1049;
exports.ER_TABLE_EXISTS_ERROR = 1050;
exports.ER_BAD_TABLE_ERROR = 1051;
exports.ER_NON_UNIQ_ERROR = 1052;
exports.ER_SERVER_SHUTDOWN = 1053;
exports.ER_BAD_FIELD_ERROR = 1054;
exports.ER_WRONG_FIELD_WITH_GROUP = 1055;
exports.ER_WRONG_GROUP_FIELD = 1056;
exports.ER_WRONG_SUM_SELECT = 1057;
exports.ER_WRONG_VALUE_COUNT = 1058;
exports.ER_TOO_LONG_IDENT = 1059;
exports.ER_DUP_FIELDNAME = 1060;
exports.ER_DUP_KEYNAME = 1061;
exports.ER_DUP_ENTRY = 1062;
exports.ER_WRONG_FIELD_SPEC = 1063;
exports.ER_PARSE_ERROR = 1064;
exports.ER_EMPTY_QUERY = 1065;
exports.ER_NONUNIQ_TABLE = 1066;
exports.ER_INVALID_DEFAULT = 1067;
exports.ER_MULTIPLE_PRI_KEY = 1068;
exports.ER_TOO_MANY_KEYS = 1069;
exports.ER_TOO_MANY_KEY_PARTS = 1070;
exports.ER_TOO_LONG_KEY = 1071;
exports.ER_KEY_COLUMN_DOES_NOT_EXITS = 1072;
exports.ER_BLOB_USED_AS_KEY = 1073;
exports.ER_TOO_BIG_FIELDLENGTH = 1074;
exports.ER_WRONG_AUTO_KEY = 1075;
exports.ER_READY = 1076;
exports.ER_NORMAL_SHUTDOWN = 1077;
exports.ER_GOT_SIGNAL = 1078;
exports.ER_SHUTDOWN_COMPLETE = 1079;
exports.ER_FORCING_CLOSE = 1080;
exports.ER_IPSOCK_ERROR = 1081;
exports.ER_NO_SUCH_INDEX = 1082;
exports.ER_WRONG_FIELD_TERMINATORS = 1083;
exports.ER_BLOBS_AND_NO_TERMINATED = 1084;
exports.ER_TEXTFILE_NOT_READABLE = 1085;
exports.ER_FILE_EXISTS_ERROR = 1086;
exports.ER_LOAD_INFO = 1087;
exports.ER_ALTER_INFO = 1088;
exports.ER_WRONG_SUB_KEY = 1089;
exports.ER_CANT_REMOVE_ALL_FIELDS = 1090;
exports.ER_CANT_DROP_FIELD_OR_KEY = 1091;
exports.ER_INSERT_INFO = 1092;
exports.ER_UPDATE_TABLE_USED = 1093;
exports.ER_NO_SUCH_THREAD = 1094;
exports.ER_KILL_DENIED_ERROR = 1095;
exports.ER_NO_TABLES_USED = 1096;
exports.ER_TOO_BIG_SET = 1097;
exports.ER_NO_UNIQUE_LOGFILE = 1098;
exports.ER_TABLE_NOT_LOCKED_FOR_WRITE = 1099;
exports.ER_TABLE_NOT_LOCKED = 1100;
exports.ER_BLOB_CANT_HAVE_DEFAULT = 1101;
exports.ER_WRONG_DB_NAME = 1102;
exports.ER_WRONG_TABLE_NAME = 1103;
exports.ER_TOO_BIG_SELECT = 1104;
exports.ER_UNKNOWN_ERROR = 1105;
exports.ER_UNKNOWN_PROCEDURE = 1106;
exports.ER_WRONG_PARAMCOUNT_TO_PROCEDURE = 1107;
exports.ER_WRONG_PARAMETERS_TO_PROCEDURE = 1108;
exports.ER_UNKNOWN_TABLE = 1109;
exports.ER_FIELD_SPECIFIED_TWICE = 1110;
exports.ER_INVALID_GROUP_FUNC_USE = 1111;
exports.ER_UNSUPPORTED_EXTENSION = 1112;
exports.ER_TABLE_MUST_HAVE_COLUMNS = 1113;
exports.ER_RECORD_FILE_FULL = 1114;
exports.ER_UNKNOWN_CHARACTER_SET = 1115;
exports.ER_TOO_MANY_TABLES = 1116;
exports.ER_TOO_MANY_FIELDS = 1117;
exports.ER_TOO_BIG_ROWSIZE = 1118;
exports.ER_STACK_OVERRUN = 1119;
exports.ER_WRONG_OUTER_JOIN = 1120;
exports.ER_NULL_COLUMN_IN_INDEX = 1121;
exports.ER_CANT_FIND_UDF = 1122;
exports.ER_CANT_INITIALIZE_UDF = 1123;
exports.ER_UDF_NO_PATHS = 1124;
exports.ER_UDF_EXISTS = 1125;
exports.ER_CANT_OPEN_LIBRARY = 1126;
exports.ER_CANT_FIND_DL_ENTRY = 1127;
exports.ER_FUNCTION_NOT_DEFINED = 1128;
exports.ER_HOST_IS_BLOCKED = 1129;
exports.ER_HOST_NOT_PRIVILEGED = 1130;
exports.ER_PASSWORD_ANONYMOUS_USER = 1131;
exports.ER_PASSWORD_NOT_ALLOWED = 1132;
exports.ER_PASSWORD_NO_MATCH = 1133;
exports.ER_UPDATE_INFO = 1134;
exports.ER_CANT_CREATE_THREAD = 1135;
exports.ER_WRONG_VALUE_COUNT_ON_ROW = 1136;
exports.ER_CANT_REOPEN_TABLE = 1137;
exports.ER_INVALID_USE_OF_NULL = 1138;
exports.ER_REGEXP_ERROR = 1139;
exports.ER_MIX_OF_GROUP_FUNC_AND_FIELDS = 1140;
exports.ER_NONEXISTING_GRANT = 1141;
exports.ER_TABLEACCESS_DENIED_ERROR = 1142;
exports.ER_COLUMNACCESS_DENIED_ERROR = 1143;
exports.ER_ILLEGAL_GRANT_FOR_TABLE = 1144;
exports.ER_GRANT_WRONG_HOST_OR_USER = 1145;
exports.ER_NO_SUCH_TABLE = 1146;
exports.ER_NONEXISTING_TABLE_GRANT = 1147;
exports.ER_NOT_ALLOWED_COMMAND = 1148;
exports.ER_SYNTAX_ERROR = 1149;
exports.ER_DELAYED_CANT_CHANGE_LOCK = 1150;
exports.ER_TOO_MANY_DELAYED_THREADS = 1151;
exports.ER_ABORTING_CONNECTION = 1152;
exports.ER_NET_PACKET_TOO_LARGE = 1153;
exports.ER_NET_READ_ERROR_FROM_PIPE = 1154;
exports.ER_NET_FCNTL_ERROR = 1155;
exports.ER_NET_PACKETS_OUT_OF_ORDER = 1156;
exports.ER_NET_UNCOMPRESS_ERROR = 1157;
exports.ER_NET_READ_ERROR = 1158;
exports.ER_NET_READ_INTERRUPTED = 1159;
exports.ER_NET_ERROR_ON_WRITE = 1160;
exports.ER_NET_WRITE_INTERRUPTED = 1161;
exports.ER_TOO_LONG_STRING = 1162;
exports.ER_TABLE_CANT_HANDLE_BLOB = 1163;
exports.ER_TABLE_CANT_HANDLE_AUTO_INCREMENT = 1164;
exports.ER_DELAYED_INSERT_TABLE_LOCKED = 1165;
exports.ER_WRONG_COLUMN_NAME = 1166;
exports.ER_WRONG_KEY_COLUMN = 1167;
exports.ER_WRONG_MRG_TABLE = 1168;
exports.ER_DUP_UNIQUE = 1169;
exports.ER_BLOB_KEY_WITHOUT_LENGTH = 1170;
exports.ER_PRIMARY_CANT_HAVE_NULL = 1171;
exports.ER_TOO_MANY_ROWS = 1172;
exports.ER_REQUIRES_PRIMARY_KEY = 1173;
exports.ER_NO_RAID_COMPILED = 1174;
exports.ER_UPDATE_WITHOUT_KEY_IN_SAFE_MODE = 1175;
exports.ER_KEY_DOES_NOT_EXITS = 1176;
exports.ER_CHECK_NO_SUCH_TABLE = 1177;
exports.ER_CHECK_NOT_IMPLEMENTED = 1178;
exports.ER_CANT_DO_THIS_DURING_AN_TRANSACTION = 1179;
exports.ER_ERROR_DURING_COMMIT = 1180;
exports.ER_ERROR_DURING_ROLLBACK = 1181;
exports.ER_ERROR_DURING_FLUSH_LOGS = 1182;
exports.ER_ERROR_DURING_CHECKPOINT = 1183;
exports.ER_NEW_ABORTING_CONNECTION = 1184;
exports.ER_DUMP_NOT_IMPLEMENTED = 1185;
exports.ER_FLUSH_MASTER_BINLOG_CLOSED = 1186;
exports.ER_INDEX_REBUILD = 1187;
exports.ER_MASTER = 1188;
exports.ER_MASTER_NET_READ = 1189;
exports.ER_MASTER_NET_WRITE = 1190;
exports.ER_FT_MATCHING_KEY_NOT_FOUND = 1191;
exports.ER_LOCK_OR_ACTIVE_TRANSACTION = 1192;
exports.ER_UNKNOWN_SYSTEM_VARIABLE = 1193;
exports.ER_CRASHED_ON_USAGE = 1194;
exports.ER_CRASHED_ON_REPAIR = 1195;
exports.ER_WARNING_NOT_COMPLETE_ROLLBACK = 1196;
exports.ER_TRANS_CACHE_FULL = 1197;
exports.ER_SLAVE_MUST_STOP = 1198;
exports.ER_SLAVE_NOT_RUNNING = 1199;
exports.ER_BAD_SLAVE = 1200;
exports.ER_MASTER_INFO = 1201;
exports.ER_SLAVE_THREAD = 1202;
exports.ER_TOO_MANY_USER_CONNECTIONS = 1203;
exports.ER_SET_CONSTANTS_ONLY = 1204;
exports.ER_LOCK_WAIT_TIMEOUT = 1205;
exports.ER_LOCK_TABLE_FULL = 1206;
exports.ER_READ_ONLY_TRANSACTION = 1207;
exports.ER_DROP_DB_WITH_READ_LOCK = 1208;
exports.ER_CREATE_DB_WITH_READ_LOCK = 1209;
exports.ER_WRONG_ARGUMENTS = 1210;
exports.ER_NO_PERMISSION_TO_CREATE_USER = 1211;
exports.ER_UNION_TABLES_IN_DIFFERENT_DIR = 1212;
exports.ER_LOCK_DEADLOCK = 1213;
exports.ER_TABLE_CANT_HANDLE_FT = 1214;
exports.ER_CANNOT_ADD_FOREIGN = 1215;
exports.ER_NO_REFERENCED_ROW = 1216;
exports.ER_ROW_IS_REFERENCED = 1217;
exports.ER_CONNECT_TO_MASTER = 1218;
exports.ER_QUERY_ON_MASTER = 1219;
exports.ER_ERROR_WHEN_EXECUTING_COMMAND = 1220;
exports.ER_WRONG_USAGE = 1221;
exports.ER_WRONG_NUMBER_OF_COLUMNS_IN_SELECT = 1222;
exports.ER_CANT_UPDATE_WITH_READLOCK = 1223;
exports.ER_MIXING_NOT_ALLOWED = 1224;
exports.ER_DUP_ARGUMENT = 1225;
exports.ER_USER_LIMIT_REACHED = 1226;
exports.ER_SPECIFIC_ACCESS_DENIED_ERROR = 1227;
exports.ER_LOCAL_VARIABLE = 1228;
exports.ER_GLOBAL_VARIABLE = 1229;
exports.ER_NO_DEFAULT = 1230;
exports.ER_WRONG_VALUE_FOR_VAR = 1231;
exports.ER_WRONG_TYPE_FOR_VAR = 1232;
exports.ER_VAR_CANT_BE_READ = 1233;
exports.ER_CANT_USE_OPTION_HERE = 1234;
exports.ER_NOT_SUPPORTED_YET = 1235;
exports.ER_MASTER_FATAL_ERROR_READING_BINLOG = 1236;
exports.ER_SLAVE_IGNORED_TABLE = 1237;
exports.ER_INCORRECT_GLOBAL_LOCAL_VAR = 1238;
exports.ER_WRONG_FK_DEF = 1239;
exports.ER_KEY_REF_DO_NOT_MATCH_TABLE_REF = 1240;
exports.ER_OPERAND_COLUMNS = 1241;
exports.ER_SUBQUERY_NO_1_ROW = 1242;
exports.ER_UNKNOWN_STMT_HANDLER = 1243;
exports.ER_CORRUPT_HELP_DB = 1244;
exports.ER_CYCLIC_REFERENCE = 1245;
exports.ER_AUTO_CONVERT = 1246;
exports.ER_ILLEGAL_REFERENCE = 1247;
exports.ER_DERIVED_MUST_HAVE_ALIAS = 1248;
exports.ER_SELECT_REDUCED = 1249;
exports.ER_TABLENAME_NOT_ALLOWED_HERE = 1250;
exports.ER_NOT_SUPPORTED_AUTH_MODE = 1251;
exports.ER_SPATIAL_CANT_HAVE_NULL = 1252;
exports.ER_COLLATION_CHARSET_MISMATCH = 1253;
exports.ER_SLAVE_WAS_RUNNING = 1254;
exports.ER_SLAVE_WAS_NOT_RUNNING = 1255;
exports.ER_TOO_BIG_FOR_UNCOMPRESS = 1256;
exports.ER_ZLIB_Z_MEM_ERROR = 1257;
exports.ER_ZLIB_Z_BUF_ERROR = 1258;
exports.ER_ZLIB_Z_DATA_ERROR = 1259;
exports.ER_CUT_VALUE_GROUP_CONCAT = 1260;
exports.ER_WARN_TOO_FEW_RECORDS = 1261;
exports.ER_WARN_TOO_MANY_RECORDS = 1262;
exports.ER_WARN_NULL_TO_NOTNULL = 1263;
exports.ER_WARN_DATA_OUT_OF_RANGE = 1264;
exports.WARN_DATA_TRUNCATED = 1265;
exports.ER_WARN_USING_OTHER_HANDLER = 1266;
exports.ER_CANT_AGGREGATE_2COLLATIONS = 1267;
exports.ER_DROP_USER = 1268;
exports.ER_REVOKE_GRANTS = 1269;
exports.ER_CANT_AGGREGATE_3COLLATIONS = 1270;
exports.ER_CANT_AGGREGATE_NCOLLATIONS = 1271;
exports.ER_VARIABLE_IS_NOT_STRUCT = 1272;
exports.ER_UNKNOWN_COLLATION = 1273;
exports.ER_SLAVE_IGNORED_SSL_PARAMS = 1274;
exports.ER_SERVER_IS_IN_SECURE_AUTH_MODE = 1275;
exports.ER_WARN_FIELD_RESOLVED = 1276;
exports.ER_BAD_SLAVE_UNTIL_COND = 1277;
exports.ER_MISSING_SKIP_SLAVE = 1278;
exports.ER_UNTIL_COND_IGNORED = 1279;
exports.ER_WRONG_NAME_FOR_INDEX = 1280;
exports.ER_WRONG_NAME_FOR_CATALOG = 1281;
exports.ER_WARN_QC_RESIZE = 1282;
exports.ER_BAD_FT_COLUMN = 1283;
exports.ER_UNKNOWN_KEY_CACHE = 1284;
exports.ER_WARN_HOSTNAME_WONT_WORK = 1285;
exports.ER_UNKNOWN_STORAGE_ENGINE = 1286;
exports.ER_WARN_DEPRECATED_SYNTAX = 1287;
exports.ER_NON_UPDATABLE_TABLE = 1288;
exports.ER_FEATURE_DISABLED = 1289;
exports.ER_OPTION_PREVENTS_STATEMENT = 1290;
exports.ER_DUPLICATED_VALUE_IN_TYPE = 1291;
exports.ER_TRUNCATED_WRONG_VALUE = 1292;
exports.ER_TOO_MUCH_AUTO_TIMESTAMP_COLS = 1293;
exports.ER_INVALID_ON_UPDATE = 1294;
exports.ER_UNSUPPORTED_PS = 1295;
exports.ER_GET_ERRMSG = 1296;
exports.ER_GET_TEMPORARY_ERRMSG = 1297;
exports.ER_UNKNOWN_TIME_ZONE = 1298;
exports.ER_WARN_INVALID_TIMESTAMP = 1299;
exports.ER_INVALID_CHARACTER_STRING = 1300;
exports.ER_WARN_ALLOWED_PACKET_OVERFLOWED = 1301;
exports.ER_CONFLICTING_DECLARATIONS = 1302;
exports.ER_SP_NO_RECURSIVE_CREATE = 1303;
exports.ER_SP_ALREADY_EXISTS = 1304;
exports.ER_SP_DOES_NOT_EXIST = 1305;
exports.ER_SP_DROP_FAILED = 1306;
exports.ER_SP_STORE_FAILED = 1307;
exports.ER_SP_LILABEL_MISMATCH = 1308;
exports.ER_SP_LABEL_REDEFINE = 1309;
exports.ER_SP_LABEL_MISMATCH = 1310;
exports.ER_SP_UNINIT_VAR = 1311;
exports.ER_SP_BADSELECT = 1312;
exports.ER_SP_BADRETURN = 1313;
exports.ER_SP_BADSTATEMENT = 1314;
exports.ER_UPDATE_LOG_DEPRECATED_IGNORED = 1315;
exports.ER_UPDATE_LOG_DEPRECATED_TRANSLATED = 1316;
exports.ER_QUERY_INTERRUPTED = 1317;
exports.ER_SP_WRONG_NO_OF_ARGS = 1318;
exports.ER_SP_COND_MISMATCH = 1319;
exports.ER_SP_NORETURN = 1320;
exports.ER_SP_NORETURNEND = 1321;
exports.ER_SP_BAD_CURSOR_QUERY = 1322;
exports.ER_SP_BAD_CURSOR_SELECT = 1323;
exports.ER_SP_CURSOR_MISMATCH = 1324;
exports.ER_SP_CURSOR_ALREADY_OPEN = 1325;
exports.ER_SP_CURSOR_NOT_OPEN = 1326;
exports.ER_SP_UNDECLARED_VAR = 1327;
exports.ER_SP_WRONG_NO_OF_FETCH_ARGS = 1328;
exports.ER_SP_FETCH_NO_DATA = 1329;
exports.ER_SP_DUP_PARAM = 1330;
exports.ER_SP_DUP_VAR = 1331;
exports.ER_SP_DUP_COND = 1332;
exports.ER_SP_DUP_CURS = 1333;
exports.ER_SP_CANT_ALTER = 1334;
exports.ER_SP_SUBSELECT_NYI = 1335;
exports.ER_STMT_NOT_ALLOWED_IN_SF_OR_TRG = 1336;
exports.ER_SP_VARCOND_AFTER_CURSHNDLR = 1337;
exports.ER_SP_CURSOR_AFTER_HANDLER = 1338;
exports.ER_SP_CASE_NOT_FOUND = 1339;
exports.ER_FPARSER_TOO_BIG_FILE = 1340;
exports.ER_FPARSER_BAD_HEADER = 1341;
exports.ER_FPARSER_EOF_IN_COMMENT = 1342;
exports.ER_FPARSER_ERROR_IN_PARAMETER = 1343;
exports.ER_FPARSER_EOF_IN_UNKNOWN_PARAMETER = 1344;
exports.ER_VIEW_NO_EXPLAIN = 1345;
exports.ER_FRM_UNKNOWN_TYPE = 1346;
exports.ER_WRONG_OBJECT = 1347;
exports.ER_NONUPDATEABLE_COLUMN = 1348;
exports.ER_VIEW_SELECT_DERIVED = 1349;
exports.ER_VIEW_SELECT_CLAUSE = 1350;
exports.ER_VIEW_SELECT_VARIABLE = 1351;
exports.ER_VIEW_SELECT_TMPTABLE = 1352;
exports.ER_VIEW_WRONG_LIST = 1353;
exports.ER_WARN_VIEW_MERGE = 1354;
exports.ER_WARN_VIEW_WITHOUT_KEY = 1355;
exports.ER_VIEW_INVALID = 1356;
exports.ER_SP_NO_DROP_SP = 1357;
exports.ER_SP_GOTO_IN_HNDLR = 1358;
exports.ER_TRG_ALREADY_EXISTS = 1359;
exports.ER_TRG_DOES_NOT_EXIST = 1360;
exports.ER_TRG_ON_VIEW_OR_TEMP_TABLE = 1361;
exports.ER_TRG_CANT_CHANGE_ROW = 1362;
exports.ER_TRG_NO_SUCH_ROW_IN_TRG = 1363;
exports.ER_NO_DEFAULT_FOR_FIELD = 1364;
exports.ER_DIVISION_BY_ZERO = 1365;
exports.ER_TRUNCATED_WRONG_VALUE_FOR_FIELD = 1366;
exports.ER_ILLEGAL_VALUE_FOR_TYPE = 1367;
exports.ER_VIEW_NONUPD_CHECK = 1368;
exports.ER_VIEW_CHECK_FAILED = 1369;
exports.ER_PROCACCESS_DENIED_ERROR = 1370;
exports.ER_RELAY_LOG_FAIL = 1371;
exports.ER_PASSWD_LENGTH = 1372;
exports.ER_UNKNOWN_TARGET_BINLOG = 1373;
exports.ER_IO_ERR_LOG_INDEX_READ = 1374;
exports.ER_BINLOG_PURGE_PROHIBITED = 1375;
exports.ER_FSEEK_FAIL = 1376;
exports.ER_BINLOG_PURGE_FATAL_ERR = 1377;
exports.ER_LOG_IN_USE = 1378;
exports.ER_LOG_PURGE_UNKNOWN_ERR = 1379;
exports.ER_RELAY_LOG_INIT = 1380;
exports.ER_NO_BINARY_LOGGING = 1381;
exports.ER_RESERVED_SYNTAX = 1382;
exports.ER_WSAS_FAILED = 1383;
exports.ER_DIFF_GROUPS_PROC = 1384;
exports.ER_NO_GROUP_FOR_PROC = 1385;
exports.ER_ORDER_WITH_PROC = 1386;
exports.ER_LOGGING_PROHIBIT_CHANGING_OF = 1387;
exports.ER_NO_FILE_MAPPING = 1388;
exports.ER_WRONG_MAGIC = 1389;
exports.ER_PS_MANY_PARAM = 1390;
exports.ER_KEY_PART_0 = 1391;
exports.ER_VIEW_CHECKSUM = 1392;
exports.ER_VIEW_MULTIUPDATE = 1393;
exports.ER_VIEW_NO_INSERT_FIELD_LIST = 1394;
exports.ER_VIEW_DELETE_MERGE_VIEW = 1395;
exports.ER_CANNOT_USER = 1396;
exports.ER_XAER_NOTA = 1397;
exports.ER_XAER_INVAL = 1398;
exports.ER_XAER_RMFAIL = 1399;
exports.ER_XAER_OUTSIDE = 1400;
exports.ER_XAER_RMERR = 1401;
exports.ER_XA_RBROLLBACK = 1402;
exports.ER_NONEXISTING_PROC_GRANT = 1403;
exports.ER_PROC_AUTO_GRANT_FAIL = 1404;
exports.ER_PROC_AUTO_REVOKE_FAIL = 1405;
exports.ER_DATA_TOO_LONG = 1406;
exports.ER_SP_BAD_SQLSTATE = 1407;
exports.ER_STARTUP = 1408;
exports.ER_LOAD_FROM_FIXED_SIZE_ROWS_TO_VAR = 1409;
exports.ER_CANT_CREATE_USER_WITH_GRANT = 1410;
exports.ER_WRONG_VALUE_FOR_TYPE = 1411;
exports.ER_TABLE_DEF_CHANGED = 1412;
exports.ER_SP_DUP_HANDLER = 1413;
exports.ER_SP_NOT_VAR_ARG = 1414;
exports.ER_SP_NO_RETSET = 1415;
exports.ER_CANT_CREATE_GEOMETRY_OBJECT = 1416;
exports.ER_FAILED_ROUTINE_BREAK_BINLOG = 1417;
exports.ER_BINLOG_UNSAFE_ROUTINE = 1418;
exports.ER_BINLOG_CREATE_ROUTINE_NEED_SUPER = 1419;
exports.ER_EXEC_STMT_WITH_OPEN_CURSOR = 1420;
exports.ER_STMT_HAS_NO_OPEN_CURSOR = 1421;
exports.ER_COMMIT_NOT_ALLOWED_IN_SF_OR_TRG = 1422;
exports.ER_NO_DEFAULT_FOR_VIEW_FIELD = 1423;
exports.ER_SP_NO_RECURSION = 1424;
exports.ER_TOO_BIG_SCALE = 1425;
exports.ER_TOO_BIG_PRECISION = 1426;
exports.ER_M_BIGGER_THAN_D = 1427;
exports.ER_WRONG_LOCK_OF_SYSTEM_TABLE = 1428;
exports.ER_CONNECT_TO_FOREIGN_DATA_SOURCE = 1429;
exports.ER_QUERY_ON_FOREIGN_DATA_SOURCE = 1430;
exports.ER_FOREIGN_DATA_SOURCE_DOESNT_EXIST = 1431;
exports.ER_FOREIGN_DATA_STRING_INVALID_CANT_CREATE = 1432;
exports.ER_FOREIGN_DATA_STRING_INVALID = 1433;
exports.ER_CANT_CREATE_FEDERATED_TABLE = 1434;
exports.ER_TRG_IN_WRONG_SCHEMA = 1435;
exports.ER_STACK_OVERRUN_NEED_MORE = 1436;
exports.ER_TOO_LONG_BODY = 1437;
exports.ER_WARN_CANT_DROP_DEFAULT_KEYCACHE = 1438;
exports.ER_TOO_BIG_DISPLAYWIDTH = 1439;
exports.ER_XAER_DUPID = 1440;
exports.ER_DATETIME_FUNCTION_OVERFLOW = 1441;
exports.ER_CANT_UPDATE_USED_TABLE_IN_SF_OR_TRG = 1442;
exports.ER_VIEW_PREVENT_UPDATE = 1443;
exports.ER_PS_NO_RECURSION = 1444;
exports.ER_SP_CANT_SET_AUTOCOMMIT = 1445;
exports.ER_MALFORMED_DEFINER = 1446;
exports.ER_VIEW_FRM_NO_USER = 1447;
exports.ER_VIEW_OTHER_USER = 1448;
exports.ER_NO_SUCH_USER = 1449;
exports.ER_FORBID_SCHEMA_CHANGE = 1450;
exports.ER_ROW_IS_REFERENCED_2 = 1451;
exports.ER_NO_REFERENCED_ROW_2 = 1452;
exports.ER_SP_BAD_VAR_SHADOW = 1453;
exports.ER_TRG_NO_DEFINER = 1454;
exports.ER_OLD_FILE_FORMAT = 1455;
exports.ER_SP_RECURSION_LIMIT = 1456;
exports.ER_SP_PROC_TABLE_CORRUPT = 1457;
exports.ER_SP_WRONG_NAME = 1458;
exports.ER_TABLE_NEEDS_UPGRADE = 1459;
exports.ER_SP_NO_AGGREGATE = 1460;
exports.ER_MAX_PREPARED_STMT_COUNT_REACHED = 1461;
exports.ER_VIEW_RECURSIVE = 1462;
exports.ER_NON_GROUPING_FIELD_USED = 1463;
exports.ER_TABLE_CANT_HANDLE_SPKEYS = 1464;
exports.ER_NO_TRIGGERS_ON_SYSTEM_SCHEMA = 1465;
exports.ER_REMOVED_SPACES = 1466;
exports.ER_AUTOINC_READ_FAILED = 1467;
exports.ER_USERNAME = 1468;
exports.ER_HOSTNAME = 1469;
exports.ER_WRONG_STRING_LENGTH = 1470;
exports.ER_NON_INSERTABLE_TABLE = 1471;
exports.ER_ADMIN_WRONG_MRG_TABLE = 1472;
exports.ER_TOO_HIGH_LEVEL_OF_NESTING_FOR_SELECT = 1473;
exports.ER_NAME_BECOMES_EMPTY = 1474;
exports.ER_AMBIGUOUS_FIELD_TERM = 1475;
exports.ER_FOREIGN_SERVER_EXISTS = 1476;
exports.ER_FOREIGN_SERVER_DOESNT_EXIST = 1477;
exports.ER_ILLEGAL_HA_CREATE_OPTION = 1478;
exports.ER_PARTITION_REQUIRES_VALUES_ERROR = 1479;
exports.ER_PARTITION_WRONG_VALUES_ERROR = 1480;
exports.ER_PARTITION_MAXVALUE_ERROR = 1481;
exports.ER_PARTITION_SUBPARTITION_ERROR = 1482;
exports.ER_PARTITION_SUBPART_MIX_ERROR = 1483;
exports.ER_PARTITION_WRONG_NO_PART_ERROR = 1484;
exports.ER_PARTITION_WRONG_NO_SUBPART_ERROR = 1485;
exports.ER_WRONG_EXPR_IN_PARTITION_FUNC_ERROR = 1486;
exports.ER_NO_CONST_EXPR_IN_RANGE_OR_LIST_ERROR = 1487;
exports.ER_FIELD_NOT_FOUND_PART_ERROR = 1488;
exports.ER_LIST_OF_FIELDS_ONLY_IN_HASH_ERROR = 1489;
exports.ER_INCONSISTENT_PARTITION_INFO_ERROR = 1490;
exports.ER_PARTITION_FUNC_NOT_ALLOWED_ERROR = 1491;
exports.ER_PARTITIONS_MUST_BE_DEFINED_ERROR = 1492;
exports.ER_RANGE_NOT_INCREASING_ERROR = 1493;
exports.ER_INCONSISTENT_TYPE_OF_FUNCTIONS_ERROR = 1494;
exports.ER_MULTIPLE_DEF_CONST_IN_LIST_PART_ERROR = 1495;
exports.ER_PARTITION_ENTRY_ERROR = 1496;
exports.ER_MIX_HANDLER_ERROR = 1497;
exports.ER_PARTITION_NOT_DEFINED_ERROR = 1498;
exports.ER_TOO_MANY_PARTITIONS_ERROR = 1499;
exports.ER_SUBPARTITION_ERROR = 1500;
exports.ER_CANT_CREATE_HANDLER_FILE = 1501;
exports.ER_BLOB_FIELD_IN_PART_FUNC_ERROR = 1502;
exports.ER_UNIQUE_KEY_NEED_ALL_FIELDS_IN_PF = 1503;
exports.ER_NO_PARTS_ERROR = 1504;
exports.ER_PARTITION_MGMT_ON_NONPARTITIONED = 1505;
exports.ER_FOREIGN_KEY_ON_PARTITIONED = 1506;
exports.ER_DROP_PARTITION_NON_EXISTENT = 1507;
exports.ER_DROP_LAST_PARTITION = 1508;
exports.ER_COALESCE_ONLY_ON_HASH_PARTITION = 1509;
exports.ER_REORG_HASH_ONLY_ON_SAME_NO = 1510;
exports.ER_REORG_NO_PARAM_ERROR = 1511;
exports.ER_ONLY_ON_RANGE_LIST_PARTITION = 1512;
exports.ER_ADD_PARTITION_SUBPART_ERROR = 1513;
exports.ER_ADD_PARTITION_NO_NEW_PARTITION = 1514;
exports.ER_COALESCE_PARTITION_NO_PARTITION = 1515;
exports.ER_REORG_PARTITION_NOT_EXIST = 1516;
exports.ER_SAME_NAME_PARTITION = 1517;
exports.ER_NO_BINLOG_ERROR = 1518;
exports.ER_CONSECUTIVE_REORG_PARTITIONS = 1519;
exports.ER_REORG_OUTSIDE_RANGE = 1520;
exports.ER_PARTITION_FUNCTION_FAILURE = 1521;
exports.ER_PART_STATE_ERROR = 1522;
exports.ER_LIMITED_PART_RANGE = 1523;
exports.ER_PLUGIN_IS_NOT_LOADED = 1524;
exports.ER_WRONG_VALUE = 1525;
exports.ER_NO_PARTITION_FOR_GIVEN_VALUE = 1526;
exports.ER_FILEGROUP_OPTION_ONLY_ONCE = 1527;
exports.ER_CREATE_FILEGROUP_FAILED = 1528;
exports.ER_DROP_FILEGROUP_FAILED = 1529;
exports.ER_TABLESPACE_AUTO_EXTEND_ERROR = 1530;
exports.ER_WRONG_SIZE_NUMBER = 1531;
exports.ER_SIZE_OVERFLOW_ERROR = 1532;
exports.ER_ALTER_FILEGROUP_FAILED = 1533;
exports.ER_BINLOG_ROW_LOGGING_FAILED = 1534;
exports.ER_BINLOG_ROW_WRONG_TABLE_DEF = 1535;
exports.ER_BINLOG_ROW_RBR_TO_SBR = 1536;
exports.ER_EVENT_ALREADY_EXISTS = 1537;
exports.ER_EVENT_STORE_FAILED = 1538;
exports.ER_EVENT_DOES_NOT_EXIST = 1539;
exports.ER_EVENT_CANT_ALTER = 1540;
exports.ER_EVENT_DROP_FAILED = 1541;
exports.ER_EVENT_INTERVAL_NOT_POSITIVE_OR_TOO_BIG = 1542;
exports.ER_EVENT_ENDS_BEFORE_STARTS = 1543;
exports.ER_EVENT_EXEC_TIME_IN_THE_PAST = 1544;
exports.ER_EVENT_OPEN_TABLE_FAILED = 1545;
exports.ER_EVENT_NEITHER_M_EXPR_NOR_M_AT = 1546;
exports.ER_COL_COUNT_DOESNT_MATCH_CORRUPTED = 1547;
exports.ER_CANNOT_LOAD_FROM_TABLE = 1548;
exports.ER_EVENT_CANNOT_DELETE = 1549;
exports.ER_EVENT_COMPILE_ERROR = 1550;
exports.ER_EVENT_SAME_NAME = 1551;
exports.ER_EVENT_DATA_TOO_LONG = 1552;
exports.ER_DROP_INDEX_FK = 1553;
exports.ER_WARN_DEPRECATED_SYNTAX_WITH_VER = 1554;
exports.ER_CANT_WRITE_LOCK_LOG_TABLE = 1555;
exports.ER_CANT_LOCK_LOG_TABLE = 1556;
exports.ER_FOREIGN_DUPLICATE_KEY = 1557;
exports.ER_COL_COUNT_DOESNT_MATCH_PLEASE_UPDATE = 1558;
exports.ER_TEMP_TABLE_PREVENTS_SWITCH_OUT_OF_RBR = 1559;
exports.ER_STORED_FUNCTION_PREVENTS_SWITCH_BINLOG_FORMAT = 1560;
exports.ER_NDB_CANT_SWITCH_BINLOG_FORMAT = 1561;
exports.ER_PARTITION_NO_TEMPORARY = 1562;
exports.ER_PARTITION_CONST_DOMAIN_ERROR = 1563;
exports.ER_PARTITION_FUNCTION_IS_NOT_ALLOWED = 1564;
exports.ER_DDL_LOG_ERROR = 1565;
exports.ER_NULL_IN_VALUES_LESS_THAN = 1566;
exports.ER_WRONG_PARTITION_NAME = 1567;
exports.ER_CANT_CHANGE_TX_CHARACTERISTICS = 1568;
exports.ER_DUP_ENTRY_AUTOINCREMENT_CASE = 1569;
exports.ER_EVENT_MODIFY_QUEUE_ERROR = 1570;
exports.ER_EVENT_SET_VAR_ERROR = 1571;
exports.ER_PARTITION_MERGE_ERROR = 1572;
exports.ER_CANT_ACTIVATE_LOG = 1573;
exports.ER_RBR_NOT_AVAILABLE = 1574;
exports.ER_BASE64_DECODE_ERROR = 1575;
exports.ER_EVENT_RECURSION_FORBIDDEN = 1576;
exports.ER_EVENTS_DB_ERROR = 1577;
exports.ER_ONLY_INTEGERS_ALLOWED = 1578;
exports.ER_UNSUPORTED_LOG_ENGINE = 1579;
exports.ER_BAD_LOG_STATEMENT = 1580;
exports.ER_CANT_RENAME_LOG_TABLE = 1581;
exports.ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT = 1582;
exports.ER_WRONG_PARAMETERS_TO_NATIVE_FCT = 1583;
exports.ER_WRONG_PARAMETERS_TO_STORED_FCT = 1584;
exports.ER_NATIVE_FCT_NAME_COLLISION = 1585;
exports.ER_DUP_ENTRY_WITH_KEY_NAME = 1586;
exports.ER_BINLOG_PURGE_EMFILE = 1587;
exports.ER_EVENT_CANNOT_CREATE_IN_THE_PAST = 1588;
exports.ER_EVENT_CANNOT_ALTER_IN_THE_PAST = 1589;
exports.ER_SLAVE_INCIDENT = 1590;
exports.ER_NO_PARTITION_FOR_GIVEN_VALUE_SILENT = 1591;
exports.ER_BINLOG_UNSAFE_STATEMENT = 1592;
exports.ER_SLAVE_FATAL_ERROR = 1593;
exports.ER_SLAVE_RELAY_LOG_READ_FAILURE = 1594;
exports.ER_SLAVE_RELAY_LOG_WRITE_FAILURE = 1595;
exports.ER_SLAVE_CREATE_EVENT_FAILURE = 1596;
exports.ER_SLAVE_MASTER_COM_FAILURE = 1597;
exports.ER_BINLOG_LOGGING_IMPOSSIBLE = 1598;
exports.ER_VIEW_NO_CREATION_CTX = 1599;
exports.ER_VIEW_INVALID_CREATION_CTX = 1600;
exports.ER_SR_INVALID_CREATION_CTX = 1601;
exports.ER_TRG_CORRUPTED_FILE = 1602;
exports.ER_TRG_NO_CREATION_CTX = 1603;
exports.ER_TRG_INVALID_CREATION_CTX = 1604;
exports.ER_EVENT_INVALID_CREATION_CTX = 1605;
exports.ER_TRG_CANT_OPEN_TABLE = 1606;
exports.ER_CANT_CREATE_SROUTINE = 1607;
exports.ER_NEVER_USED = 1608;
exports.ER_NO_FORMAT_DESCRIPTION_EVENT_BEFORE_BINLOG_STATEMENT = 1609;
exports.ER_SLAVE_CORRUPT_EVENT = 1610;
exports.ER_LOAD_DATA_INVALID_COLUMN = 1611;
exports.ER_LOG_PURGE_NO_FILE = 1612;
exports.ER_XA_RBTIMEOUT = 1613;
exports.ER_XA_RBDEADLOCK = 1614;
exports.ER_NEED_REPREPARE = 1615;
exports.ER_DELAYED_NOT_SUPPORTED = 1616;
exports.WARN_NO_MASTER_INFO = 1617;
exports.WARN_OPTION_IGNORED = 1618;
exports.WARN_PLUGIN_DELETE_BUILTIN = 1619;
exports.WARN_PLUGIN_BUSY = 1620;
exports.ER_VARIABLE_IS_READONLY = 1621;
exports.ER_WARN_ENGINE_TRANSACTION_ROLLBACK = 1622;
exports.ER_SLAVE_HEARTBEAT_FAILURE = 1623;
exports.ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE = 1624;
exports.ER_NDB_REPLICATION_SCHEMA_ERROR = 1625;
exports.ER_CONFLICT_FN_PARSE_ERROR = 1626;
exports.ER_EXCEPTIONS_WRITE_ERROR = 1627;
exports.ER_TOO_LONG_TABLE_COMMENT = 1628;
exports.ER_TOO_LONG_FIELD_COMMENT = 1629;
exports.ER_FUNC_INEXISTENT_NAME_COLLISION = 1630;
exports.ER_DATABASE_NAME = 1631;
exports.ER_TABLE_NAME = 1632;
exports.ER_PARTITION_NAME = 1633;
exports.ER_SUBPARTITION_NAME = 1634;
exports.ER_TEMPORARY_NAME = 1635;
exports.ER_RENAMED_NAME = 1636;
exports.ER_TOO_MANY_CONCURRENT_TRXS = 1637;
exports.WARN_NON_ASCII_SEPARATOR_NOT_IMPLEMENTED = 1638;
exports.ER_DEBUG_SYNC_TIMEOUT = 1639;
exports.ER_DEBUG_SYNC_HIT_LIMIT = 1640;
exports.ER_DUP_SIGNAL_SET = 1641;
exports.ER_SIGNAL_WARN = 1642;
exports.ER_SIGNAL_NOT_FOUND = 1643;
exports.ER_SIGNAL_EXCEPTION = 1644;
exports.ER_RESIGNAL_WITHOUT_ACTIVE_HANDLER = 1645;
exports.ER_SIGNAL_BAD_CONDITION_TYPE = 1646;
exports.WARN_COND_ITEM_TRUNCATED = 1647;
exports.ER_COND_ITEM_TOO_LONG = 1648;
exports.ER_UNKNOWN_LOCALE = 1649;
exports.ER_SLAVE_IGNORE_SERVER_IDS = 1650;
exports.ER_QUERY_CACHE_DISABLED = 1651;
exports.ER_SAME_NAME_PARTITION_FIELD = 1652;
exports.ER_PARTITION_COLUMN_LIST_ERROR = 1653;
exports.ER_WRONG_TYPE_COLUMN_VALUE_ERROR = 1654;
exports.ER_TOO_MANY_PARTITION_FUNC_FIELDS_ERROR = 1655;
exports.ER_MAXVALUE_IN_VALUES_IN = 1656;
exports.ER_TOO_MANY_VALUES_ERROR = 1657;
exports.ER_ROW_SINGLE_PARTITION_FIELD_ERROR = 1658;
exports.ER_FIELD_TYPE_NOT_ALLOWED_AS_PARTITION_FIELD = 1659;
exports.ER_PARTITION_FIELDS_TOO_LONG = 1660;
exports.ER_BINLOG_ROW_ENGINE_AND_STMT_ENGINE = 1661;
exports.ER_BINLOG_ROW_MODE_AND_STMT_ENGINE = 1662;
exports.ER_BINLOG_UNSAFE_AND_STMT_ENGINE = 1663;
exports.ER_BINLOG_ROW_INJECTION_AND_STMT_ENGINE = 1664;
exports.ER_BINLOG_STMT_MODE_AND_ROW_ENGINE = 1665;
exports.ER_BINLOG_ROW_INJECTION_AND_STMT_MODE = 1666;
exports.ER_BINLOG_MULTIPLE_ENGINES_AND_SELF_LOGGING_ENGINE = 1667;
exports.ER_BINLOG_UNSAFE_LIMIT = 1668;
exports.ER_BINLOG_UNSAFE_INSERT_DELAYED = 1669;
exports.ER_BINLOG_UNSAFE_SYSTEM_TABLE = 1670;
exports.ER_BINLOG_UNSAFE_AUTOINC_COLUMNS = 1671;
exports.ER_BINLOG_UNSAFE_UDF = 1672;
exports.ER_BINLOG_UNSAFE_SYSTEM_VARIABLE = 1673;
exports.ER_BINLOG_UNSAFE_SYSTEM_FUNCTION = 1674;
exports.ER_BINLOG_UNSAFE_NONTRANS_AFTER_TRANS = 1675;
exports.ER_MESSAGE_AND_STATEMENT = 1676;
exports.ER_SLAVE_CONVERSION_FAILED = 1677;
exports.ER_SLAVE_CANT_CREATE_CONVERSION = 1678;
exports.ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_BINLOG_FORMAT = 1679;
exports.ER_PATH_LENGTH = 1680;
exports.ER_WARN_DEPRECATED_SYNTAX_NO_REPLACEMENT = 1681;
exports.ER_WRONG_NATIVE_TABLE_STRUCTURE = 1682;
exports.ER_WRONG_PERFSCHEMA_USAGE = 1683;
exports.ER_WARN_I_S_SKIPPED_TABLE = 1684;
exports.ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_BINLOG_DIRECT = 1685;
exports.ER_STORED_FUNCTION_PREVENTS_SWITCH_BINLOG_DIRECT = 1686;
exports.ER_SPATIAL_MUST_HAVE_GEOM_COL = 1687;
exports.ER_TOO_LONG_INDEX_COMMENT = 1688;
exports.ER_LOCK_ABORTED = 1689;
exports.ER_DATA_OUT_OF_RANGE = 1690;
exports.ER_WRONG_SPVAR_TYPE_IN_LIMIT = 1691;
exports.ER_BINLOG_UNSAFE_MULTIPLE_ENGINES_AND_SELF_LOGGING_ENGINE = 1692;
exports.ER_BINLOG_UNSAFE_MIXED_STATEMENT = 1693;
exports.ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_SQL_LOG_BIN = 1694;
exports.ER_STORED_FUNCTION_PREVENTS_SWITCH_SQL_LOG_BIN = 1695;
exports.ER_FAILED_READ_FROM_PAR_FILE = 1696;
exports.ER_VALUES_IS_NOT_INT_TYPE_ERROR = 1697;
exports.ER_ACCESS_DENIED_NO_PASSWORD_ERROR = 1698;
exports.ER_SET_PASSWORD_AUTH_PLUGIN = 1699;
exports.ER_GRANT_PLUGIN_USER_EXISTS = 1700;
exports.ER_TRUNCATE_ILLEGAL_FK = 1701;
exports.ER_PLUGIN_IS_PERMANENT = 1702;
exports.ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE_MIN = 1703;
exports.ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE_MAX = 1704;
exports.ER_STMT_CACHE_FULL = 1705;
exports.ER_MULTI_UPDATE_KEY_CONFLICT = 1706;
exports.ER_TABLE_NEEDS_REBUILD = 1707;
exports.WARN_OPTION_BELOW_LIMIT = 1708;
exports.ER_INDEX_COLUMN_TOO_LONG = 1709;
exports.ER_ERROR_IN_TRIGGER_BODY = 1710;
exports.ER_ERROR_IN_UNKNOWN_TRIGGER_BODY = 1711;
exports.ER_INDEX_CORRUPT = 1712;
exports.ER_UNDO_RECORD_TOO_BIG = 1713;
exports.ER_BINLOG_UNSAFE_INSERT_IGNORE_SELECT = 1714;
exports.ER_BINLOG_UNSAFE_INSERT_SELECT_UPDATE = 1715;
exports.ER_BINLOG_UNSAFE_REPLACE_SELECT = 1716;
exports.ER_BINLOG_UNSAFE_CREATE_IGNORE_SELECT = 1717;
exports.ER_BINLOG_UNSAFE_CREATE_REPLACE_SELECT = 1718;
exports.ER_BINLOG_UNSAFE_UPDATE_IGNORE = 1719;
exports.ER_PLUGIN_NO_UNINSTALL = 1720;
exports.ER_PLUGIN_NO_INSTALL = 1721;
exports.ER_BINLOG_UNSAFE_WRITE_AUTOINC_SELECT = 1722;
exports.ER_BINLOG_UNSAFE_CREATE_SELECT_AUTOINC = 1723;
exports.ER_BINLOG_UNSAFE_INSERT_TWO_KEYS = 1724;
exports.ER_TABLE_IN_FK_CHECK = 1725;
exports.ER_UNSUPPORTED_ENGINE = 1726;
exports.ER_BINLOG_UNSAFE_AUTOINC_NOT_FIRST = 1727;
exports.ER_CANNOT_LOAD_FROM_TABLE_V2 = 1728;
exports.ER_MASTER_DELAY_VALUE_OUT_OF_RANGE = 1729;
exports.ER_ONLY_FD_AND_RBR_EVENTS_ALLOWED_IN_BINLOG_STATEMENT = 1730;
exports.ER_PARTITION_EXCHANGE_DIFFERENT_OPTION = 1731;
exports.ER_PARTITION_EXCHANGE_PART_TABLE = 1732;
exports.ER_PARTITION_EXCHANGE_TEMP_TABLE = 1733;
exports.ER_PARTITION_INSTEAD_OF_SUBPARTITION = 1734;
exports.ER_UNKNOWN_PARTITION = 1735;
exports.ER_TABLES_DIFFERENT_METADATA = 1736;
exports.ER_ROW_DOES_NOT_MATCH_PARTITION = 1737;
exports.ER_BINLOG_CACHE_SIZE_GREATER_THAN_MAX = 1738;
exports.ER_WARN_INDEX_NOT_APPLICABLE = 1739;
exports.ER_PARTITION_EXCHANGE_FOREIGN_KEY = 1740;
exports.ER_NO_SUCH_KEY_VALUE = 1741;
exports.ER_RPL_INFO_DATA_TOO_LONG = 1742;
exports.ER_NETWORK_READ_EVENT_CHECKSUM_FAILURE = 1743;
exports.ER_BINLOG_READ_EVENT_CHECKSUM_FAILURE = 1744;
exports.ER_BINLOG_STMT_CACHE_SIZE_GREATER_THAN_MAX = 1745;
exports.ER_CANT_UPDATE_TABLE_IN_CREATE_TABLE_SELECT = 1746;
exports.ER_PARTITION_CLAUSE_ON_NONPARTITIONED = 1747;
exports.ER_ROW_DOES_NOT_MATCH_GIVEN_PARTITION_SET = 1748;
exports.ER_NO_SUCH_PARTITION = 1749;
exports.ER_CHANGE_RPL_INFO_REPOSITORY_FAILURE = 1750;
exports.ER_WARNING_NOT_COMPLETE_ROLLBACK_WITH_CREATED_TEMP_TABLE = 1751;
exports.ER_WARNING_NOT_COMPLETE_ROLLBACK_WITH_DROPPED_TEMP_TABLE = 1752;
exports.ER_MTS_FEATURE_IS_NOT_SUPPORTED = 1753;
exports.ER_MTS_UPDATED_DBS_GREATER_MAX = 1754;
exports.ER_MTS_CANT_PARALLEL = 1755;
exports.ER_MTS_INCONSISTENT_DATA = 1756;
exports.ER_FULLTEXT_NOT_SUPPORTED_WITH_PARTITIONING = 1757;
exports.ER_DA_INVALID_CONDITION_NUMBER = 1758;
exports.ER_INSECURE_PLAIN_TEXT = 1759;
exports.ER_INSECURE_CHANGE_MASTER = 1760;
exports.ER_FOREIGN_DUPLICATE_KEY_WITH_CHILD_INFO = 1761;
exports.ER_FOREIGN_DUPLICATE_KEY_WITHOUT_CHILD_INFO = 1762;
exports.ER_SQLTHREAD_WITH_SECURE_SLAVE = 1763;
exports.ER_TABLE_HAS_NO_FT = 1764;
exports.ER_VARIABLE_NOT_SETTABLE_IN_SF_OR_TRIGGER = 1765;
exports.ER_VARIABLE_NOT_SETTABLE_IN_TRANSACTION = 1766;
exports.ER_GTID_NEXT_IS_NOT_IN_GTID_NEXT_LIST = 1767;
exports.ER_CANT_CHANGE_GTID_NEXT_IN_TRANSACTION_WHEN_GTID_NEXT_LIST_IS_NULL = 1768;
exports.ER_SET_STATEMENT_CANNOT_INVOKE_FUNCTION = 1769;
exports.ER_GTID_NEXT_CANT_BE_AUTOMATIC_IF_GTID_NEXT_LIST_IS_NON_NULL = 1770;
exports.ER_SKIPPING_LOGGED_TRANSACTION = 1771;
exports.ER_MALFORMED_GTID_SET_SPECIFICATION = 1772;
exports.ER_MALFORMED_GTID_SET_ENCODING = 1773;
exports.ER_MALFORMED_GTID_SPECIFICATION = 1774;
exports.ER_GNO_EXHAUSTED = 1775;
exports.ER_BAD_SLAVE_AUTO_POSITION = 1776;
exports.ER_AUTO_POSITION_REQUIRES_GTID_MODE_ON = 1777;
exports.ER_CANT_DO_IMPLICIT_COMMIT_IN_TRX_WHEN_GTID_NEXT_IS_SET = 1778;
exports.ER_GTID_MODE_2_OR_3_REQUIRES_ENFORCE_GTID_CONSISTENCY_ON = 1779;
exports.ER_GTID_MODE_REQUIRES_BINLOG = 1780;
exports.ER_CANT_SET_GTID_NEXT_TO_GTID_WHEN_GTID_MODE_IS_OFF = 1781;
exports.ER_CANT_SET_GTID_NEXT_TO_ANONYMOUS_WHEN_GTID_MODE_IS_ON = 1782;
exports.ER_CANT_SET_GTID_NEXT_LIST_TO_NON_NULL_WHEN_GTID_MODE_IS_OFF = 1783;
exports.ER_FOUND_GTID_EVENT_WHEN_GTID_MODE_IS_OFF = 1784;
exports.ER_GTID_UNSAFE_NON_TRANSACTIONAL_TABLE = 1785;
exports.ER_GTID_UNSAFE_CREATE_SELECT = 1786;
exports.ER_GTID_UNSAFE_CREATE_DROP_TEMPORARY_TABLE_IN_TRANSACTION = 1787;
exports.ER_GTID_MODE_CAN_ONLY_CHANGE_ONE_STEP_AT_A_TIME = 1788;
exports.ER_MASTER_HAS_PURGED_REQUIRED_GTIDS = 1789;
exports.ER_CANT_SET_GTID_NEXT_WHEN_OWNING_GTID = 1790;
exports.ER_UNKNOWN_EXPLAIN_FORMAT = 1791;
exports.ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION = 1792;
exports.ER_TOO_LONG_TABLE_PARTITION_COMMENT = 1793;
exports.ER_SLAVE_CONFIGURATION = 1794;
exports.ER_INNODB_FT_LIMIT = 1795;
exports.ER_INNODB_NO_FT_TEMP_TABLE = 1796;
exports.ER_INNODB_FT_WRONG_DOCID_COLUMN = 1797;
exports.ER_INNODB_FT_WRONG_DOCID_INDEX = 1798;
exports.ER_INNODB_ONLINE_LOG_TOO_BIG = 1799;
exports.ER_UNKNOWN_ALTER_ALGORITHM = 1800;
exports.ER_UNKNOWN_ALTER_LOCK = 1801;
exports.ER_MTS_CHANGE_MASTER_CANT_RUN_WITH_GAPS = 1802;
exports.ER_MTS_RECOVERY_FAILURE = 1803;
exports.ER_MTS_RESET_WORKERS = 1804;
exports.ER_COL_COUNT_DOESNT_MATCH_CORRUPTED_V2 = 1805;
exports.ER_SLAVE_SILENT_RETRY_TRANSACTION = 1806;
exports.ER_DISCARD_FK_CHECKS_RUNNING = 1807;
exports.ER_TABLE_SCHEMA_MISMATCH = 1808;
exports.ER_TABLE_IN_SYSTEM_TABLESPACE = 1809;
exports.ER_IO_READ_ERROR = 1810;
exports.ER_IO_WRITE_ERROR = 1811;
exports.ER_TABLESPACE_MISSING = 1812;
exports.ER_TABLESPACE_EXISTS = 1813;
exports.ER_TABLESPACE_DISCARDED = 1814;
exports.ER_INTERNAL_ERROR = 1815;
exports.ER_INNODB_IMPORT_ERROR = 1816;
exports.ER_INNODB_INDEX_CORRUPT = 1817;
exports.ER_INVALID_YEAR_COLUMN_LENGTH = 1818;
exports.ER_NOT_VALID_PASSWORD = 1819;
exports.ER_MUST_CHANGE_PASSWORD = 1820;
exports.ER_FK_NO_INDEX_CHILD = 1821;
exports.ER_FK_NO_INDEX_PARENT = 1822;
exports.ER_FK_FAIL_ADD_SYSTEM = 1823;
exports.ER_FK_CANNOT_OPEN_PARENT = 1824;
exports.ER_FK_INCORRECT_OPTION = 1825;
exports.ER_FK_DUP_NAME = 1826;
exports.ER_PASSWORD_FORMAT = 1827;
exports.ER_FK_COLUMN_CANNOT_DROP = 1828;
exports.ER_FK_COLUMN_CANNOT_DROP_CHILD = 1829;
exports.ER_FK_COLUMN_NOT_NULL = 1830;
exports.ER_DUP_INDEX = 1831;
exports.ER_FK_COLUMN_CANNOT_CHANGE = 1832;
exports.ER_FK_COLUMN_CANNOT_CHANGE_CHILD = 1833;
exports.ER_FK_CANNOT_DELETE_PARENT = 1834;
exports.ER_MALFORMED_PACKET = 1835;
exports.ER_READ_ONLY_MODE = 1836;
exports.ER_GTID_NEXT_TYPE_UNDEFINED_GROUP = 1837;
exports.ER_VARIABLE_NOT_SETTABLE_IN_SP = 1838;
exports.ER_CANT_SET_GTID_PURGED_WHEN_GTID_MODE_IS_OFF = 1839;
exports.ER_CANT_SET_GTID_PURGED_WHEN_GTID_EXECUTED_IS_NOT_EMPTY = 1840;
exports.ER_CANT_SET_GTID_PURGED_WHEN_OWNED_GTIDS_IS_NOT_EMPTY = 1841;
exports.ER_GTID_PURGED_WAS_CHANGED = 1842;
exports.ER_GTID_EXECUTED_WAS_CHANGED = 1843;
exports.ER_BINLOG_STMT_MODE_AND_NO_REPL_TABLES = 1844;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED = 1845;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON = 1846;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_COPY = 1847;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_PARTITION = 1848;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FK_RENAME = 1849;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_COLUMN_TYPE = 1850;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FK_CHECK = 1851;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_IGNORE = 1852;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_NOPK = 1853;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_AUTOINC = 1854;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_HIDDEN_FTS = 1855;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_CHANGE_FTS = 1856;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FTS = 1857;
exports.ER_SQL_SLAVE_SKIP_COUNTER_NOT_SETTABLE_IN_GTID_MODE = 1858;
exports.ER_DUP_UNKNOWN_IN_INDEX = 1859;
exports.ER_IDENT_CAUSES_TOO_LONG_PATH = 1860;
exports.ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_NOT_NULL = 1861;
exports.ER_MUST_CHANGE_PASSWORD_LOGIN = 1862;
exports.ER_ROW_IN_WRONG_PARTITION = 1863;
exports.ER_MTS_EVENT_BIGGER_PENDING_JOBS_SIZE_MAX = 1864;
exports.ER_INNODB_NO_FT_USES_PARSER = 1865;
exports.ER_BINLOG_LOGICAL_CORRUPTION = 1866;
exports.ER_WARN_PURGE_LOG_IN_USE = 1867;
exports.ER_WARN_PURGE_LOG_IS_ACTIVE = 1868;
exports.ER_AUTO_INCREMENT_CONFLICT = 1869;
exports.WARN_ON_BLOCKHOLE_IN_RBR = 1870;
exports.ER_SLAVE_MI_INIT_REPOSITORY = 1871;
exports.ER_SLAVE_RLI_INIT_REPOSITORY = 1872;
exports.ER_ACCESS_DENIED_CHANGE_USER_ERROR = 1873;
exports.ER_INNODB_READ_ONLY = 1874;
exports.ER_STOP_SLAVE_SQL_THREAD_TIMEOUT = 1875;
exports.ER_STOP_SLAVE_IO_THREAD_TIMEOUT = 1876;
exports.ER_TABLE_CORRUPT = 1877;
exports.ER_TEMP_FILE_WRITE_FAILURE = 1878;
exports.ER_INNODB_FT_AUX_NOT_HEX_ID = 1879;
exports.ER_OLD_TEMPORALS_UPGRADED = 1880;
exports.ER_INNODB_FORCED_RECOVERY = 1881;
exports.ER_AES_INVALID_IV = 1882;

// Lookup-by-number table
exports[1] = 'EE_CANTCREATEFILE';
exports[2] = 'EE_READ';
exports[3] = 'EE_WRITE';
exports[4] = 'EE_BADCLOSE';
exports[5] = 'EE_OUTOFMEMORY';
exports[6] = 'EE_DELETE';
exports[7] = 'EE_LINK';
exports[9] = 'EE_EOFERR';
exports[10] = 'EE_CANTLOCK';
exports[11] = 'EE_CANTUNLOCK';
exports[12] = 'EE_DIR';
exports[13] = 'EE_STAT';
exports[14] = 'EE_CANT_CHSIZE';
exports[15] = 'EE_CANT_OPEN_STREAM';
exports[16] = 'EE_GETWD';
exports[17] = 'EE_SETWD';
exports[18] = 'EE_LINK_WARNING';
exports[19] = 'EE_OPEN_WARNING';
exports[20] = 'EE_DISK_FULL';
exports[21] = 'EE_CANT_MKDIR';
exports[22] = 'EE_UNKNOWN_CHARSET';
exports[23] = 'EE_OUT_OF_FILERESOURCES';
exports[24] = 'EE_CANT_READLINK';
exports[25] = 'EE_CANT_SYMLINK';
exports[26] = 'EE_REALPATH';
exports[27] = 'EE_SYNC';
exports[28] = 'EE_UNKNOWN_COLLATION';
exports[29] = 'EE_FILENOTFOUND';
exports[30] = 'EE_FILE_NOT_CLOSED';
exports[31] = 'EE_CHANGE_OWNERSHIP';
exports[32] = 'EE_CHANGE_PERMISSIONS';
exports[33] = 'EE_CANT_SEEK';
exports[120] = 'HA_ERR_KEY_NOT_FOUND';
exports[121] = 'HA_ERR_FOUND_DUPP_KEY';
exports[122] = 'HA_ERR_INTERNAL_ERROR';
exports[123] = 'HA_ERR_RECORD_CHANGED';
exports[124] = 'HA_ERR_WRONG_INDEX';
exports[126] = 'HA_ERR_CRASHED';
exports[127] = 'HA_ERR_WRONG_IN_RECORD';
exports[128] = 'HA_ERR_OUT_OF_MEM';
exports[130] = 'HA_ERR_NOT_A_TABLE';
exports[131] = 'HA_ERR_WRONG_COMMAND';
exports[132] = 'HA_ERR_OLD_FILE';
exports[133] = 'HA_ERR_NO_ACTIVE_RECORD';
exports[134] = 'HA_ERR_RECORD_DELETED';
exports[135] = 'HA_ERR_RECORD_FILE_FULL';
exports[136] = 'HA_ERR_INDEX_FILE_FULL';
exports[137] = 'HA_ERR_END_OF_FILE';
exports[138] = 'HA_ERR_UNSUPPORTED';
exports[139] = 'HA_ERR_TO_BIG_ROW';
exports[140] = 'HA_WRONG_CREATE_OPTION';
exports[141] = 'HA_ERR_FOUND_DUPP_UNIQUE';
exports[142] = 'HA_ERR_UNKNOWN_CHARSET';
exports[143] = 'HA_ERR_WRONG_MRG_TABLE_DEF';
exports[144] = 'HA_ERR_CRASHED_ON_REPAIR';
exports[145] = 'HA_ERR_CRASHED_ON_USAGE';
exports[146] = 'HA_ERR_LOCK_WAIT_TIMEOUT';
exports[147] = 'HA_ERR_LOCK_TABLE_FULL';
exports[148] = 'HA_ERR_READ_ONLY_TRANSACTION';
exports[149] = 'HA_ERR_LOCK_DEADLOCK';
exports[150] = 'HA_ERR_CANNOT_ADD_FOREIGN';
exports[151] = 'HA_ERR_NO_REFERENCED_ROW';
exports[152] = 'HA_ERR_ROW_IS_REFERENCED';
exports[153] = 'HA_ERR_NO_SAVEPOINT';
exports[154] = 'HA_ERR_NON_UNIQUE_BLOCK_SIZE';
exports[155] = 'HA_ERR_NO_SUCH_TABLE';
exports[156] = 'HA_ERR_TABLE_EXIST';
exports[157] = 'HA_ERR_NO_CONNECTION';
exports[158] = 'HA_ERR_NULL_IN_SPATIAL';
exports[159] = 'HA_ERR_TABLE_DEF_CHANGED';
exports[160] = 'HA_ERR_NO_PARTITION_FOUND';
exports[161] = 'HA_ERR_RBR_LOGGING_FAILED';
exports[162] = 'HA_ERR_DROP_INDEX_FK';
exports[163] = 'HA_ERR_FOREIGN_DUPLICATE_KEY';
exports[164] = 'HA_ERR_TABLE_NEEDS_UPGRADE';
exports[165] = 'HA_ERR_TABLE_READONLY';
exports[166] = 'HA_ERR_AUTOINC_READ_FAILED';
exports[167] = 'HA_ERR_AUTOINC_ERANGE';
exports[168] = 'HA_ERR_GENERIC';
exports[169] = 'HA_ERR_RECORD_IS_THE_SAME';
exports[170] = 'HA_ERR_LOGGING_IMPOSSIBLE';
exports[171] = 'HA_ERR_CORRUPT_EVENT';
exports[172] = 'HA_ERR_NEW_FILE';
exports[173] = 'HA_ERR_ROWS_EVENT_APPLY';
exports[174] = 'HA_ERR_INITIALIZATION';
exports[175] = 'HA_ERR_FILE_TOO_SHORT';
exports[176] = 'HA_ERR_WRONG_CRC';
exports[177] = 'HA_ERR_TOO_MANY_CONCURRENT_TRXS';
exports[178] = 'HA_ERR_NOT_IN_LOCK_PARTITIONS';
exports[179] = 'HA_ERR_INDEX_COL_TOO_LONG';
exports[180] = 'HA_ERR_INDEX_CORRUPT';
exports[181] = 'HA_ERR_UNDO_REC_TOO_BIG';
exports[182] = 'HA_FTS_INVALID_DOCID';
exports[183] = 'HA_ERR_TABLE_IN_FK_CHECK';
exports[184] = 'HA_ERR_TABLESPACE_EXISTS';
exports[185] = 'HA_ERR_TOO_MANY_FIELDS';
exports[186] = 'HA_ERR_ROW_IN_WRONG_PARTITION';
exports[187] = 'HA_ERR_INNODB_READ_ONLY';
exports[188] = 'HA_ERR_FTS_EXCEED_RESULT_CACHE_LIMIT';
exports[189] = 'HA_ERR_TEMP_FILE_WRITE_FAILURE';
exports[190] = 'HA_ERR_INNODB_FORCED_RECOVERY';
exports[191] = 'HA_ERR_FTS_TOO_MANY_WORDS_IN_PHRASE';
exports[1000] = 'ER_HASHCHK';
exports[1001] = 'ER_NISAMCHK';
exports[1002] = 'ER_NO';
exports[1003] = 'ER_YES';
exports[1004] = 'ER_CANT_CREATE_FILE';
exports[1005] = 'ER_CANT_CREATE_TABLE';
exports[1006] = 'ER_CANT_CREATE_DB';
exports[1007] = 'ER_DB_CREATE_EXISTS';
exports[1008] = 'ER_DB_DROP_EXISTS';
exports[1009] = 'ER_DB_DROP_DELETE';
exports[1010] = 'ER_DB_DROP_RMDIR';
exports[1011] = 'ER_CANT_DELETE_FILE';
exports[1012] = 'ER_CANT_FIND_SYSTEM_REC';
exports[1013] = 'ER_CANT_GET_STAT';
exports[1014] = 'ER_CANT_GET_WD';
exports[1015] = 'ER_CANT_LOCK';
exports[1016] = 'ER_CANT_OPEN_FILE';
exports[1017] = 'ER_FILE_NOT_FOUND';
exports[1018] = 'ER_CANT_READ_DIR';
exports[1019] = 'ER_CANT_SET_WD';
exports[1020] = 'ER_CHECKREAD';
exports[1021] = 'ER_DISK_FULL';
exports[1022] = 'ER_DUP_KEY';
exports[1023] = 'ER_ERROR_ON_CLOSE';
exports[1024] = 'ER_ERROR_ON_READ';
exports[1025] = 'ER_ERROR_ON_RENAME';
exports[1026] = 'ER_ERROR_ON_WRITE';
exports[1027] = 'ER_FILE_USED';
exports[1028] = 'ER_FILSORT_ABORT';
exports[1029] = 'ER_FORM_NOT_FOUND';
exports[1030] = 'ER_GET_ERRNO';
exports[1031] = 'ER_ILLEGAL_HA';
exports[1032] = 'ER_KEY_NOT_FOUND';
exports[1033] = 'ER_NOT_FORM_FILE';
exports[1034] = 'ER_NOT_KEYFILE';
exports[1035] = 'ER_OLD_KEYFILE';
exports[1036] = 'ER_OPEN_AS_READONLY';
exports[1037] = 'ER_OUTOFMEMORY';
exports[1038] = 'ER_OUT_OF_SORTMEMORY';
exports[1039] = 'ER_UNEXPECTED_EOF';
exports[1040] = 'ER_CON_COUNT_ERROR';
exports[1041] = 'ER_OUT_OF_RESOURCES';
exports[1042] = 'ER_BAD_HOST_ERROR';
exports[1043] = 'ER_HANDSHAKE_ERROR';
exports[1044] = 'ER_DBACCESS_DENIED_ERROR';
exports[1045] = 'ER_ACCESS_DENIED_ERROR';
exports[1046] = 'ER_NO_DB_ERROR';
exports[1047] = 'ER_UNKNOWN_COM_ERROR';
exports[1048] = 'ER_BAD_NULL_ERROR';
exports[1049] = 'ER_BAD_DB_ERROR';
exports[1050] = 'ER_TABLE_EXISTS_ERROR';
exports[1051] = 'ER_BAD_TABLE_ERROR';
exports[1052] = 'ER_NON_UNIQ_ERROR';
exports[1053] = 'ER_SERVER_SHUTDOWN';
exports[1054] = 'ER_BAD_FIELD_ERROR';
exports[1055] = 'ER_WRONG_FIELD_WITH_GROUP';
exports[1056] = 'ER_WRONG_GROUP_FIELD';
exports[1057] = 'ER_WRONG_SUM_SELECT';
exports[1058] = 'ER_WRONG_VALUE_COUNT';
exports[1059] = 'ER_TOO_LONG_IDENT';
exports[1060] = 'ER_DUP_FIELDNAME';
exports[1061] = 'ER_DUP_KEYNAME';
exports[1062] = 'ER_DUP_ENTRY';
exports[1063] = 'ER_WRONG_FIELD_SPEC';
exports[1064] = 'ER_PARSE_ERROR';
exports[1065] = 'ER_EMPTY_QUERY';
exports[1066] = 'ER_NONUNIQ_TABLE';
exports[1067] = 'ER_INVALID_DEFAULT';
exports[1068] = 'ER_MULTIPLE_PRI_KEY';
exports[1069] = 'ER_TOO_MANY_KEYS';
exports[1070] = 'ER_TOO_MANY_KEY_PARTS';
exports[1071] = 'ER_TOO_LONG_KEY';
exports[1072] = 'ER_KEY_COLUMN_DOES_NOT_EXITS';
exports[1073] = 'ER_BLOB_USED_AS_KEY';
exports[1074] = 'ER_TOO_BIG_FIELDLENGTH';
exports[1075] = 'ER_WRONG_AUTO_KEY';
exports[1076] = 'ER_READY';
exports[1077] = 'ER_NORMAL_SHUTDOWN';
exports[1078] = 'ER_GOT_SIGNAL';
exports[1079] = 'ER_SHUTDOWN_COMPLETE';
exports[1080] = 'ER_FORCING_CLOSE';
exports[1081] = 'ER_IPSOCK_ERROR';
exports[1082] = 'ER_NO_SUCH_INDEX';
exports[1083] = 'ER_WRONG_FIELD_TERMINATORS';
exports[1084] = 'ER_BLOBS_AND_NO_TERMINATED';
exports[1085] = 'ER_TEXTFILE_NOT_READABLE';
exports[1086] = 'ER_FILE_EXISTS_ERROR';
exports[1087] = 'ER_LOAD_INFO';
exports[1088] = 'ER_ALTER_INFO';
exports[1089] = 'ER_WRONG_SUB_KEY';
exports[1090] = 'ER_CANT_REMOVE_ALL_FIELDS';
exports[1091] = 'ER_CANT_DROP_FIELD_OR_KEY';
exports[1092] = 'ER_INSERT_INFO';
exports[1093] = 'ER_UPDATE_TABLE_USED';
exports[1094] = 'ER_NO_SUCH_THREAD';
exports[1095] = 'ER_KILL_DENIED_ERROR';
exports[1096] = 'ER_NO_TABLES_USED';
exports[1097] = 'ER_TOO_BIG_SET';
exports[1098] = 'ER_NO_UNIQUE_LOGFILE';
exports[1099] = 'ER_TABLE_NOT_LOCKED_FOR_WRITE';
exports[1100] = 'ER_TABLE_NOT_LOCKED';
exports[1101] = 'ER_BLOB_CANT_HAVE_DEFAULT';
exports[1102] = 'ER_WRONG_DB_NAME';
exports[1103] = 'ER_WRONG_TABLE_NAME';
exports[1104] = 'ER_TOO_BIG_SELECT';
exports[1105] = 'ER_UNKNOWN_ERROR';
exports[1106] = 'ER_UNKNOWN_PROCEDURE';
exports[1107] = 'ER_WRONG_PARAMCOUNT_TO_PROCEDURE';
exports[1108] = 'ER_WRONG_PARAMETERS_TO_PROCEDURE';
exports[1109] = 'ER_UNKNOWN_TABLE';
exports[1110] = 'ER_FIELD_SPECIFIED_TWICE';
exports[1111] = 'ER_INVALID_GROUP_FUNC_USE';
exports[1112] = 'ER_UNSUPPORTED_EXTENSION';
exports[1113] = 'ER_TABLE_MUST_HAVE_COLUMNS';
exports[1114] = 'ER_RECORD_FILE_FULL';
exports[1115] = 'ER_UNKNOWN_CHARACTER_SET';
exports[1116] = 'ER_TOO_MANY_TABLES';
exports[1117] = 'ER_TOO_MANY_FIELDS';
exports[1118] = 'ER_TOO_BIG_ROWSIZE';
exports[1119] = 'ER_STACK_OVERRUN';
exports[1120] = 'ER_WRONG_OUTER_JOIN';
exports[1121] = 'ER_NULL_COLUMN_IN_INDEX';
exports[1122] = 'ER_CANT_FIND_UDF';
exports[1123] = 'ER_CANT_INITIALIZE_UDF';
exports[1124] = 'ER_UDF_NO_PATHS';
exports[1125] = 'ER_UDF_EXISTS';
exports[1126] = 'ER_CANT_OPEN_LIBRARY';
exports[1127] = 'ER_CANT_FIND_DL_ENTRY';
exports[1128] = 'ER_FUNCTION_NOT_DEFINED';
exports[1129] = 'ER_HOST_IS_BLOCKED';
exports[1130] = 'ER_HOST_NOT_PRIVILEGED';
exports[1131] = 'ER_PASSWORD_ANONYMOUS_USER';
exports[1132] = 'ER_PASSWORD_NOT_ALLOWED';
exports[1133] = 'ER_PASSWORD_NO_MATCH';
exports[1134] = 'ER_UPDATE_INFO';
exports[1135] = 'ER_CANT_CREATE_THREAD';
exports[1136] = 'ER_WRONG_VALUE_COUNT_ON_ROW';
exports[1137] = 'ER_CANT_REOPEN_TABLE';
exports[1138] = 'ER_INVALID_USE_OF_NULL';
exports[1139] = 'ER_REGEXP_ERROR';
exports[1140] = 'ER_MIX_OF_GROUP_FUNC_AND_FIELDS';
exports[1141] = 'ER_NONEXISTING_GRANT';
exports[1142] = 'ER_TABLEACCESS_DENIED_ERROR';
exports[1143] = 'ER_COLUMNACCESS_DENIED_ERROR';
exports[1144] = 'ER_ILLEGAL_GRANT_FOR_TABLE';
exports[1145] = 'ER_GRANT_WRONG_HOST_OR_USER';
exports[1146] = 'ER_NO_SUCH_TABLE';
exports[1147] = 'ER_NONEXISTING_TABLE_GRANT';
exports[1148] = 'ER_NOT_ALLOWED_COMMAND';
exports[1149] = 'ER_SYNTAX_ERROR';
exports[1150] = 'ER_DELAYED_CANT_CHANGE_LOCK';
exports[1151] = 'ER_TOO_MANY_DELAYED_THREADS';
exports[1152] = 'ER_ABORTING_CONNECTION';
exports[1153] = 'ER_NET_PACKET_TOO_LARGE';
exports[1154] = 'ER_NET_READ_ERROR_FROM_PIPE';
exports[1155] = 'ER_NET_FCNTL_ERROR';
exports[1156] = 'ER_NET_PACKETS_OUT_OF_ORDER';
exports[1157] = 'ER_NET_UNCOMPRESS_ERROR';
exports[1158] = 'ER_NET_READ_ERROR';
exports[1159] = 'ER_NET_READ_INTERRUPTED';
exports[1160] = 'ER_NET_ERROR_ON_WRITE';
exports[1161] = 'ER_NET_WRITE_INTERRUPTED';
exports[1162] = 'ER_TOO_LONG_STRING';
exports[1163] = 'ER_TABLE_CANT_HANDLE_BLOB';
exports[1164] = 'ER_TABLE_CANT_HANDLE_AUTO_INCREMENT';
exports[1165] = 'ER_DELAYED_INSERT_TABLE_LOCKED';
exports[1166] = 'ER_WRONG_COLUMN_NAME';
exports[1167] = 'ER_WRONG_KEY_COLUMN';
exports[1168] = 'ER_WRONG_MRG_TABLE';
exports[1169] = 'ER_DUP_UNIQUE';
exports[1170] = 'ER_BLOB_KEY_WITHOUT_LENGTH';
exports[1171] = 'ER_PRIMARY_CANT_HAVE_NULL';
exports[1172] = 'ER_TOO_MANY_ROWS';
exports[1173] = 'ER_REQUIRES_PRIMARY_KEY';
exports[1174] = 'ER_NO_RAID_COMPILED';
exports[1175] = 'ER_UPDATE_WITHOUT_KEY_IN_SAFE_MODE';
exports[1176] = 'ER_KEY_DOES_NOT_EXITS';
exports[1177] = 'ER_CHECK_NO_SUCH_TABLE';
exports[1178] = 'ER_CHECK_NOT_IMPLEMENTED';
exports[1179] = 'ER_CANT_DO_THIS_DURING_AN_TRANSACTION';
exports[1180] = 'ER_ERROR_DURING_COMMIT';
exports[1181] = 'ER_ERROR_DURING_ROLLBACK';
exports[1182] = 'ER_ERROR_DURING_FLUSH_LOGS';
exports[1183] = 'ER_ERROR_DURING_CHECKPOINT';
exports[1184] = 'ER_NEW_ABORTING_CONNECTION';
exports[1185] = 'ER_DUMP_NOT_IMPLEMENTED';
exports[1186] = 'ER_FLUSH_MASTER_BINLOG_CLOSED';
exports[1187] = 'ER_INDEX_REBUILD';
exports[1188] = 'ER_MASTER';
exports[1189] = 'ER_MASTER_NET_READ';
exports[1190] = 'ER_MASTER_NET_WRITE';
exports[1191] = 'ER_FT_MATCHING_KEY_NOT_FOUND';
exports[1192] = 'ER_LOCK_OR_ACTIVE_TRANSACTION';
exports[1193] = 'ER_UNKNOWN_SYSTEM_VARIABLE';
exports[1194] = 'ER_CRASHED_ON_USAGE';
exports[1195] = 'ER_CRASHED_ON_REPAIR';
exports[1196] = 'ER_WARNING_NOT_COMPLETE_ROLLBACK';
exports[1197] = 'ER_TRANS_CACHE_FULL';
exports[1198] = 'ER_SLAVE_MUST_STOP';
exports[1199] = 'ER_SLAVE_NOT_RUNNING';
exports[1200] = 'ER_BAD_SLAVE';
exports[1201] = 'ER_MASTER_INFO';
exports[1202] = 'ER_SLAVE_THREAD';
exports[1203] = 'ER_TOO_MANY_USER_CONNECTIONS';
exports[1204] = 'ER_SET_CONSTANTS_ONLY';
exports[1205] = 'ER_LOCK_WAIT_TIMEOUT';
exports[1206] = 'ER_LOCK_TABLE_FULL';
exports[1207] = 'ER_READ_ONLY_TRANSACTION';
exports[1208] = 'ER_DROP_DB_WITH_READ_LOCK';
exports[1209] = 'ER_CREATE_DB_WITH_READ_LOCK';
exports[1210] = 'ER_WRONG_ARGUMENTS';
exports[1211] = 'ER_NO_PERMISSION_TO_CREATE_USER';
exports[1212] = 'ER_UNION_TABLES_IN_DIFFERENT_DIR';
exports[1213] = 'ER_LOCK_DEADLOCK';
exports[1214] = 'ER_TABLE_CANT_HANDLE_FT';
exports[1215] = 'ER_CANNOT_ADD_FOREIGN';
exports[1216] = 'ER_NO_REFERENCED_ROW';
exports[1217] = 'ER_ROW_IS_REFERENCED';
exports[1218] = 'ER_CONNECT_TO_MASTER';
exports[1219] = 'ER_QUERY_ON_MASTER';
exports[1220] = 'ER_ERROR_WHEN_EXECUTING_COMMAND';
exports[1221] = 'ER_WRONG_USAGE';
exports[1222] = 'ER_WRONG_NUMBER_OF_COLUMNS_IN_SELECT';
exports[1223] = 'ER_CANT_UPDATE_WITH_READLOCK';
exports[1224] = 'ER_MIXING_NOT_ALLOWED';
exports[1225] = 'ER_DUP_ARGUMENT';
exports[1226] = 'ER_USER_LIMIT_REACHED';
exports[1227] = 'ER_SPECIFIC_ACCESS_DENIED_ERROR';
exports[1228] = 'ER_LOCAL_VARIABLE';
exports[1229] = 'ER_GLOBAL_VARIABLE';
exports[1230] = 'ER_NO_DEFAULT';
exports[1231] = 'ER_WRONG_VALUE_FOR_VAR';
exports[1232] = 'ER_WRONG_TYPE_FOR_VAR';
exports[1233] = 'ER_VAR_CANT_BE_READ';
exports[1234] = 'ER_CANT_USE_OPTION_HERE';
exports[1235] = 'ER_NOT_SUPPORTED_YET';
exports[1236] = 'ER_MASTER_FATAL_ERROR_READING_BINLOG';
exports[1237] = 'ER_SLAVE_IGNORED_TABLE';
exports[1238] = 'ER_INCORRECT_GLOBAL_LOCAL_VAR';
exports[1239] = 'ER_WRONG_FK_DEF';
exports[1240] = 'ER_KEY_REF_DO_NOT_MATCH_TABLE_REF';
exports[1241] = 'ER_OPERAND_COLUMNS';
exports[1242] = 'ER_SUBQUERY_NO_1_ROW';
exports[1243] = 'ER_UNKNOWN_STMT_HANDLER';
exports[1244] = 'ER_CORRUPT_HELP_DB';
exports[1245] = 'ER_CYCLIC_REFERENCE';
exports[1246] = 'ER_AUTO_CONVERT';
exports[1247] = 'ER_ILLEGAL_REFERENCE';
exports[1248] = 'ER_DERIVED_MUST_HAVE_ALIAS';
exports[1249] = 'ER_SELECT_REDUCED';
exports[1250] = 'ER_TABLENAME_NOT_ALLOWED_HERE';
exports[1251] = 'ER_NOT_SUPPORTED_AUTH_MODE';
exports[1252] = 'ER_SPATIAL_CANT_HAVE_NULL';
exports[1253] = 'ER_COLLATION_CHARSET_MISMATCH';
exports[1254] = 'ER_SLAVE_WAS_RUNNING';
exports[1255] = 'ER_SLAVE_WAS_NOT_RUNNING';
exports[1256] = 'ER_TOO_BIG_FOR_UNCOMPRESS';
exports[1257] = 'ER_ZLIB_Z_MEM_ERROR';
exports[1258] = 'ER_ZLIB_Z_BUF_ERROR';
exports[1259] = 'ER_ZLIB_Z_DATA_ERROR';
exports[1260] = 'ER_CUT_VALUE_GROUP_CONCAT';
exports[1261] = 'ER_WARN_TOO_FEW_RECORDS';
exports[1262] = 'ER_WARN_TOO_MANY_RECORDS';
exports[1263] = 'ER_WARN_NULL_TO_NOTNULL';
exports[1264] = 'ER_WARN_DATA_OUT_OF_RANGE';
exports[1265] = 'WARN_DATA_TRUNCATED';
exports[1266] = 'ER_WARN_USING_OTHER_HANDLER';
exports[1267] = 'ER_CANT_AGGREGATE_2COLLATIONS';
exports[1268] = 'ER_DROP_USER';
exports[1269] = 'ER_REVOKE_GRANTS';
exports[1270] = 'ER_CANT_AGGREGATE_3COLLATIONS';
exports[1271] = 'ER_CANT_AGGREGATE_NCOLLATIONS';
exports[1272] = 'ER_VARIABLE_IS_NOT_STRUCT';
exports[1273] = 'ER_UNKNOWN_COLLATION';
exports[1274] = 'ER_SLAVE_IGNORED_SSL_PARAMS';
exports[1275] = 'ER_SERVER_IS_IN_SECURE_AUTH_MODE';
exports[1276] = 'ER_WARN_FIELD_RESOLVED';
exports[1277] = 'ER_BAD_SLAVE_UNTIL_COND';
exports[1278] = 'ER_MISSING_SKIP_SLAVE';
exports[1279] = 'ER_UNTIL_COND_IGNORED';
exports[1280] = 'ER_WRONG_NAME_FOR_INDEX';
exports[1281] = 'ER_WRONG_NAME_FOR_CATALOG';
exports[1282] = 'ER_WARN_QC_RESIZE';
exports[1283] = 'ER_BAD_FT_COLUMN';
exports[1284] = 'ER_UNKNOWN_KEY_CACHE';
exports[1285] = 'ER_WARN_HOSTNAME_WONT_WORK';
exports[1286] = 'ER_UNKNOWN_STORAGE_ENGINE';
exports[1287] = 'ER_WARN_DEPRECATED_SYNTAX';
exports[1288] = 'ER_NON_UPDATABLE_TABLE';
exports[1289] = 'ER_FEATURE_DISABLED';
exports[1290] = 'ER_OPTION_PREVENTS_STATEMENT';
exports[1291] = 'ER_DUPLICATED_VALUE_IN_TYPE';
exports[1292] = 'ER_TRUNCATED_WRONG_VALUE';
exports[1293] = 'ER_TOO_MUCH_AUTO_TIMESTAMP_COLS';
exports[1294] = 'ER_INVALID_ON_UPDATE';
exports[1295] = 'ER_UNSUPPORTED_PS';
exports[1296] = 'ER_GET_ERRMSG';
exports[1297] = 'ER_GET_TEMPORARY_ERRMSG';
exports[1298] = 'ER_UNKNOWN_TIME_ZONE';
exports[1299] = 'ER_WARN_INVALID_TIMESTAMP';
exports[1300] = 'ER_INVALID_CHARACTER_STRING';
exports[1301] = 'ER_WARN_ALLOWED_PACKET_OVERFLOWED';
exports[1302] = 'ER_CONFLICTING_DECLARATIONS';
exports[1303] = 'ER_SP_NO_RECURSIVE_CREATE';
exports[1304] = 'ER_SP_ALREADY_EXISTS';
exports[1305] = 'ER_SP_DOES_NOT_EXIST';
exports[1306] = 'ER_SP_DROP_FAILED';
exports[1307] = 'ER_SP_STORE_FAILED';
exports[1308] = 'ER_SP_LILABEL_MISMATCH';
exports[1309] = 'ER_SP_LABEL_REDEFINE';
exports[1310] = 'ER_SP_LABEL_MISMATCH';
exports[1311] = 'ER_SP_UNINIT_VAR';
exports[1312] = 'ER_SP_BADSELECT';
exports[1313] = 'ER_SP_BADRETURN';
exports[1314] = 'ER_SP_BADSTATEMENT';
exports[1315] = 'ER_UPDATE_LOG_DEPRECATED_IGNORED';
exports[1316] = 'ER_UPDATE_LOG_DEPRECATED_TRANSLATED';
exports[1317] = 'ER_QUERY_INTERRUPTED';
exports[1318] = 'ER_SP_WRONG_NO_OF_ARGS';
exports[1319] = 'ER_SP_COND_MISMATCH';
exports[1320] = 'ER_SP_NORETURN';
exports[1321] = 'ER_SP_NORETURNEND';
exports[1322] = 'ER_SP_BAD_CURSOR_QUERY';
exports[1323] = 'ER_SP_BAD_CURSOR_SELECT';
exports[1324] = 'ER_SP_CURSOR_MISMATCH';
exports[1325] = 'ER_SP_CURSOR_ALREADY_OPEN';
exports[1326] = 'ER_SP_CURSOR_NOT_OPEN';
exports[1327] = 'ER_SP_UNDECLARED_VAR';
exports[1328] = 'ER_SP_WRONG_NO_OF_FETCH_ARGS';
exports[1329] = 'ER_SP_FETCH_NO_DATA';
exports[1330] = 'ER_SP_DUP_PARAM';
exports[1331] = 'ER_SP_DUP_VAR';
exports[1332] = 'ER_SP_DUP_COND';
exports[1333] = 'ER_SP_DUP_CURS';
exports[1334] = 'ER_SP_CANT_ALTER';
exports[1335] = 'ER_SP_SUBSELECT_NYI';
exports[1336] = 'ER_STMT_NOT_ALLOWED_IN_SF_OR_TRG';
exports[1337] = 'ER_SP_VARCOND_AFTER_CURSHNDLR';
exports[1338] = 'ER_SP_CURSOR_AFTER_HANDLER';
exports[1339] = 'ER_SP_CASE_NOT_FOUND';
exports[1340] = 'ER_FPARSER_TOO_BIG_FILE';
exports[1341] = 'ER_FPARSER_BAD_HEADER';
exports[1342] = 'ER_FPARSER_EOF_IN_COMMENT';
exports[1343] = 'ER_FPARSER_ERROR_IN_PARAMETER';
exports[1344] = 'ER_FPARSER_EOF_IN_UNKNOWN_PARAMETER';
exports[1345] = 'ER_VIEW_NO_EXPLAIN';
exports[1346] = 'ER_FRM_UNKNOWN_TYPE';
exports[1347] = 'ER_WRONG_OBJECT';
exports[1348] = 'ER_NONUPDATEABLE_COLUMN';
exports[1349] = 'ER_VIEW_SELECT_DERIVED';
exports[1350] = 'ER_VIEW_SELECT_CLAUSE';
exports[1351] = 'ER_VIEW_SELECT_VARIABLE';
exports[1352] = 'ER_VIEW_SELECT_TMPTABLE';
exports[1353] = 'ER_VIEW_WRONG_LIST';
exports[1354] = 'ER_WARN_VIEW_MERGE';
exports[1355] = 'ER_WARN_VIEW_WITHOUT_KEY';
exports[1356] = 'ER_VIEW_INVALID';
exports[1357] = 'ER_SP_NO_DROP_SP';
exports[1358] = 'ER_SP_GOTO_IN_HNDLR';
exports[1359] = 'ER_TRG_ALREADY_EXISTS';
exports[1360] = 'ER_TRG_DOES_NOT_EXIST';
exports[1361] = 'ER_TRG_ON_VIEW_OR_TEMP_TABLE';
exports[1362] = 'ER_TRG_CANT_CHANGE_ROW';
exports[1363] = 'ER_TRG_NO_SUCH_ROW_IN_TRG';
exports[1364] = 'ER_NO_DEFAULT_FOR_FIELD';
exports[1365] = 'ER_DIVISION_BY_ZERO';
exports[1366] = 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD';
exports[1367] = 'ER_ILLEGAL_VALUE_FOR_TYPE';
exports[1368] = 'ER_VIEW_NONUPD_CHECK';
exports[1369] = 'ER_VIEW_CHECK_FAILED';
exports[1370] = 'ER_PROCACCESS_DENIED_ERROR';
exports[1371] = 'ER_RELAY_LOG_FAIL';
exports[1372] = 'ER_PASSWD_LENGTH';
exports[1373] = 'ER_UNKNOWN_TARGET_BINLOG';
exports[1374] = 'ER_IO_ERR_LOG_INDEX_READ';
exports[1375] = 'ER_BINLOG_PURGE_PROHIBITED';
exports[1376] = 'ER_FSEEK_FAIL';
exports[1377] = 'ER_BINLOG_PURGE_FATAL_ERR';
exports[1378] = 'ER_LOG_IN_USE';
exports[1379] = 'ER_LOG_PURGE_UNKNOWN_ERR';
exports[1380] = 'ER_RELAY_LOG_INIT';
exports[1381] = 'ER_NO_BINARY_LOGGING';
exports[1382] = 'ER_RESERVED_SYNTAX';
exports[1383] = 'ER_WSAS_FAILED';
exports[1384] = 'ER_DIFF_GROUPS_PROC';
exports[1385] = 'ER_NO_GROUP_FOR_PROC';
exports[1386] = 'ER_ORDER_WITH_PROC';
exports[1387] = 'ER_LOGGING_PROHIBIT_CHANGING_OF';
exports[1388] = 'ER_NO_FILE_MAPPING';
exports[1389] = 'ER_WRONG_MAGIC';
exports[1390] = 'ER_PS_MANY_PARAM';
exports[1391] = 'ER_KEY_PART_0';
exports[1392] = 'ER_VIEW_CHECKSUM';
exports[1393] = 'ER_VIEW_MULTIUPDATE';
exports[1394] = 'ER_VIEW_NO_INSERT_FIELD_LIST';
exports[1395] = 'ER_VIEW_DELETE_MERGE_VIEW';
exports[1396] = 'ER_CANNOT_USER';
exports[1397] = 'ER_XAER_NOTA';
exports[1398] = 'ER_XAER_INVAL';
exports[1399] = 'ER_XAER_RMFAIL';
exports[1400] = 'ER_XAER_OUTSIDE';
exports[1401] = 'ER_XAER_RMERR';
exports[1402] = 'ER_XA_RBROLLBACK';
exports[1403] = 'ER_NONEXISTING_PROC_GRANT';
exports[1404] = 'ER_PROC_AUTO_GRANT_FAIL';
exports[1405] = 'ER_PROC_AUTO_REVOKE_FAIL';
exports[1406] = 'ER_DATA_TOO_LONG';
exports[1407] = 'ER_SP_BAD_SQLSTATE';
exports[1408] = 'ER_STARTUP';
exports[1409] = 'ER_LOAD_FROM_FIXED_SIZE_ROWS_TO_VAR';
exports[1410] = 'ER_CANT_CREATE_USER_WITH_GRANT';
exports[1411] = 'ER_WRONG_VALUE_FOR_TYPE';
exports[1412] = 'ER_TABLE_DEF_CHANGED';
exports[1413] = 'ER_SP_DUP_HANDLER';
exports[1414] = 'ER_SP_NOT_VAR_ARG';
exports[1415] = 'ER_SP_NO_RETSET';
exports[1416] = 'ER_CANT_CREATE_GEOMETRY_OBJECT';
exports[1417] = 'ER_FAILED_ROUTINE_BREAK_BINLOG';
exports[1418] = 'ER_BINLOG_UNSAFE_ROUTINE';
exports[1419] = 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER';
exports[1420] = 'ER_EXEC_STMT_WITH_OPEN_CURSOR';
exports[1421] = 'ER_STMT_HAS_NO_OPEN_CURSOR';
exports[1422] = 'ER_COMMIT_NOT_ALLOWED_IN_SF_OR_TRG';
exports[1423] = 'ER_NO_DEFAULT_FOR_VIEW_FIELD';
exports[1424] = 'ER_SP_NO_RECURSION';
exports[1425] = 'ER_TOO_BIG_SCALE';
exports[1426] = 'ER_TOO_BIG_PRECISION';
exports[1427] = 'ER_M_BIGGER_THAN_D';
exports[1428] = 'ER_WRONG_LOCK_OF_SYSTEM_TABLE';
exports[1429] = 'ER_CONNECT_TO_FOREIGN_DATA_SOURCE';
exports[1430] = 'ER_QUERY_ON_FOREIGN_DATA_SOURCE';
exports[1431] = 'ER_FOREIGN_DATA_SOURCE_DOESNT_EXIST';
exports[1432] = 'ER_FOREIGN_DATA_STRING_INVALID_CANT_CREATE';
exports[1433] = 'ER_FOREIGN_DATA_STRING_INVALID';
exports[1434] = 'ER_CANT_CREATE_FEDERATED_TABLE';
exports[1435] = 'ER_TRG_IN_WRONG_SCHEMA';
exports[1436] = 'ER_STACK_OVERRUN_NEED_MORE';
exports[1437] = 'ER_TOO_LONG_BODY';
exports[1438] = 'ER_WARN_CANT_DROP_DEFAULT_KEYCACHE';
exports[1439] = 'ER_TOO_BIG_DISPLAYWIDTH';
exports[1440] = 'ER_XAER_DUPID';
exports[1441] = 'ER_DATETIME_FUNCTION_OVERFLOW';
exports[1442] = 'ER_CANT_UPDATE_USED_TABLE_IN_SF_OR_TRG';
exports[1443] = 'ER_VIEW_PREVENT_UPDATE';
exports[1444] = 'ER_PS_NO_RECURSION';
exports[1445] = 'ER_SP_CANT_SET_AUTOCOMMIT';
exports[1446] = 'ER_MALFORMED_DEFINER';
exports[1447] = 'ER_VIEW_FRM_NO_USER';
exports[1448] = 'ER_VIEW_OTHER_USER';
exports[1449] = 'ER_NO_SUCH_USER';
exports[1450] = 'ER_FORBID_SCHEMA_CHANGE';
exports[1451] = 'ER_ROW_IS_REFERENCED_2';
exports[1452] = 'ER_NO_REFERENCED_ROW_2';
exports[1453] = 'ER_SP_BAD_VAR_SHADOW';
exports[1454] = 'ER_TRG_NO_DEFINER';
exports[1455] = 'ER_OLD_FILE_FORMAT';
exports[1456] = 'ER_SP_RECURSION_LIMIT';
exports[1457] = 'ER_SP_PROC_TABLE_CORRUPT';
exports[1458] = 'ER_SP_WRONG_NAME';
exports[1459] = 'ER_TABLE_NEEDS_UPGRADE';
exports[1460] = 'ER_SP_NO_AGGREGATE';
exports[1461] = 'ER_MAX_PREPARED_STMT_COUNT_REACHED';
exports[1462] = 'ER_VIEW_RECURSIVE';
exports[1463] = 'ER_NON_GROUPING_FIELD_USED';
exports[1464] = 'ER_TABLE_CANT_HANDLE_SPKEYS';
exports[1465] = 'ER_NO_TRIGGERS_ON_SYSTEM_SCHEMA';
exports[1466] = 'ER_REMOVED_SPACES';
exports[1467] = 'ER_AUTOINC_READ_FAILED';
exports[1468] = 'ER_USERNAME';
exports[1469] = 'ER_HOSTNAME';
exports[1470] = 'ER_WRONG_STRING_LENGTH';
exports[1471] = 'ER_NON_INSERTABLE_TABLE';
exports[1472] = 'ER_ADMIN_WRONG_MRG_TABLE';
exports[1473] = 'ER_TOO_HIGH_LEVEL_OF_NESTING_FOR_SELECT';
exports[1474] = 'ER_NAME_BECOMES_EMPTY';
exports[1475] = 'ER_AMBIGUOUS_FIELD_TERM';
exports[1476] = 'ER_FOREIGN_SERVER_EXISTS';
exports[1477] = 'ER_FOREIGN_SERVER_DOESNT_EXIST';
exports[1478] = 'ER_ILLEGAL_HA_CREATE_OPTION';
exports[1479] = 'ER_PARTITION_REQUIRES_VALUES_ERROR';
exports[1480] = 'ER_PARTITION_WRONG_VALUES_ERROR';
exports[1481] = 'ER_PARTITION_MAXVALUE_ERROR';
exports[1482] = 'ER_PARTITION_SUBPARTITION_ERROR';
exports[1483] = 'ER_PARTITION_SUBPART_MIX_ERROR';
exports[1484] = 'ER_PARTITION_WRONG_NO_PART_ERROR';
exports[1485] = 'ER_PARTITION_WRONG_NO_SUBPART_ERROR';
exports[1486] = 'ER_WRONG_EXPR_IN_PARTITION_FUNC_ERROR';
exports[1487] = 'ER_NO_CONST_EXPR_IN_RANGE_OR_LIST_ERROR';
exports[1488] = 'ER_FIELD_NOT_FOUND_PART_ERROR';
exports[1489] = 'ER_LIST_OF_FIELDS_ONLY_IN_HASH_ERROR';
exports[1490] = 'ER_INCONSISTENT_PARTITION_INFO_ERROR';
exports[1491] = 'ER_PARTITION_FUNC_NOT_ALLOWED_ERROR';
exports[1492] = 'ER_PARTITIONS_MUST_BE_DEFINED_ERROR';
exports[1493] = 'ER_RANGE_NOT_INCREASING_ERROR';
exports[1494] = 'ER_INCONSISTENT_TYPE_OF_FUNCTIONS_ERROR';
exports[1495] = 'ER_MULTIPLE_DEF_CONST_IN_LIST_PART_ERROR';
exports[1496] = 'ER_PARTITION_ENTRY_ERROR';
exports[1497] = 'ER_MIX_HANDLER_ERROR';
exports[1498] = 'ER_PARTITION_NOT_DEFINED_ERROR';
exports[1499] = 'ER_TOO_MANY_PARTITIONS_ERROR';
exports[1500] = 'ER_SUBPARTITION_ERROR';
exports[1501] = 'ER_CANT_CREATE_HANDLER_FILE';
exports[1502] = 'ER_BLOB_FIELD_IN_PART_FUNC_ERROR';
exports[1503] = 'ER_UNIQUE_KEY_NEED_ALL_FIELDS_IN_PF';
exports[1504] = 'ER_NO_PARTS_ERROR';
exports[1505] = 'ER_PARTITION_MGMT_ON_NONPARTITIONED';
exports[1506] = 'ER_FOREIGN_KEY_ON_PARTITIONED';
exports[1507] = 'ER_DROP_PARTITION_NON_EXISTENT';
exports[1508] = 'ER_DROP_LAST_PARTITION';
exports[1509] = 'ER_COALESCE_ONLY_ON_HASH_PARTITION';
exports[1510] = 'ER_REORG_HASH_ONLY_ON_SAME_NO';
exports[1511] = 'ER_REORG_NO_PARAM_ERROR';
exports[1512] = 'ER_ONLY_ON_RANGE_LIST_PARTITION';
exports[1513] = 'ER_ADD_PARTITION_SUBPART_ERROR';
exports[1514] = 'ER_ADD_PARTITION_NO_NEW_PARTITION';
exports[1515] = 'ER_COALESCE_PARTITION_NO_PARTITION';
exports[1516] = 'ER_REORG_PARTITION_NOT_EXIST';
exports[1517] = 'ER_SAME_NAME_PARTITION';
exports[1518] = 'ER_NO_BINLOG_ERROR';
exports[1519] = 'ER_CONSECUTIVE_REORG_PARTITIONS';
exports[1520] = 'ER_REORG_OUTSIDE_RANGE';
exports[1521] = 'ER_PARTITION_FUNCTION_FAILURE';
exports[1522] = 'ER_PART_STATE_ERROR';
exports[1523] = 'ER_LIMITED_PART_RANGE';
exports[1524] = 'ER_PLUGIN_IS_NOT_LOADED';
exports[1525] = 'ER_WRONG_VALUE';
exports[1526] = 'ER_NO_PARTITION_FOR_GIVEN_VALUE';
exports[1527] = 'ER_FILEGROUP_OPTION_ONLY_ONCE';
exports[1528] = 'ER_CREATE_FILEGROUP_FAILED';
exports[1529] = 'ER_DROP_FILEGROUP_FAILED';
exports[1530] = 'ER_TABLESPACE_AUTO_EXTEND_ERROR';
exports[1531] = 'ER_WRONG_SIZE_NUMBER';
exports[1532] = 'ER_SIZE_OVERFLOW_ERROR';
exports[1533] = 'ER_ALTER_FILEGROUP_FAILED';
exports[1534] = 'ER_BINLOG_ROW_LOGGING_FAILED';
exports[1535] = 'ER_BINLOG_ROW_WRONG_TABLE_DEF';
exports[1536] = 'ER_BINLOG_ROW_RBR_TO_SBR';
exports[1537] = 'ER_EVENT_ALREADY_EXISTS';
exports[1538] = 'ER_EVENT_STORE_FAILED';
exports[1539] = 'ER_EVENT_DOES_NOT_EXIST';
exports[1540] = 'ER_EVENT_CANT_ALTER';
exports[1541] = 'ER_EVENT_DROP_FAILED';
exports[1542] = 'ER_EVENT_INTERVAL_NOT_POSITIVE_OR_TOO_BIG';
exports[1543] = 'ER_EVENT_ENDS_BEFORE_STARTS';
exports[1544] = 'ER_EVENT_EXEC_TIME_IN_THE_PAST';
exports[1545] = 'ER_EVENT_OPEN_TABLE_FAILED';
exports[1546] = 'ER_EVENT_NEITHER_M_EXPR_NOR_M_AT';
exports[1547] = 'ER_COL_COUNT_DOESNT_MATCH_CORRUPTED';
exports[1548] = 'ER_CANNOT_LOAD_FROM_TABLE';
exports[1549] = 'ER_EVENT_CANNOT_DELETE';
exports[1550] = 'ER_EVENT_COMPILE_ERROR';
exports[1551] = 'ER_EVENT_SAME_NAME';
exports[1552] = 'ER_EVENT_DATA_TOO_LONG';
exports[1553] = 'ER_DROP_INDEX_FK';
exports[1554] = 'ER_WARN_DEPRECATED_SYNTAX_WITH_VER';
exports[1555] = 'ER_CANT_WRITE_LOCK_LOG_TABLE';
exports[1556] = 'ER_CANT_LOCK_LOG_TABLE';
exports[1557] = 'ER_FOREIGN_DUPLICATE_KEY';
exports[1558] = 'ER_COL_COUNT_DOESNT_MATCH_PLEASE_UPDATE';
exports[1559] = 'ER_TEMP_TABLE_PREVENTS_SWITCH_OUT_OF_RBR';
exports[1560] = 'ER_STORED_FUNCTION_PREVENTS_SWITCH_BINLOG_FORMAT';
exports[1561] = 'ER_NDB_CANT_SWITCH_BINLOG_FORMAT';
exports[1562] = 'ER_PARTITION_NO_TEMPORARY';
exports[1563] = 'ER_PARTITION_CONST_DOMAIN_ERROR';
exports[1564] = 'ER_PARTITION_FUNCTION_IS_NOT_ALLOWED';
exports[1565] = 'ER_DDL_LOG_ERROR';
exports[1566] = 'ER_NULL_IN_VALUES_LESS_THAN';
exports[1567] = 'ER_WRONG_PARTITION_NAME';
exports[1568] = 'ER_CANT_CHANGE_TX_CHARACTERISTICS';
exports[1569] = 'ER_DUP_ENTRY_AUTOINCREMENT_CASE';
exports[1570] = 'ER_EVENT_MODIFY_QUEUE_ERROR';
exports[1571] = 'ER_EVENT_SET_VAR_ERROR';
exports[1572] = 'ER_PARTITION_MERGE_ERROR';
exports[1573] = 'ER_CANT_ACTIVATE_LOG';
exports[1574] = 'ER_RBR_NOT_AVAILABLE';
exports[1575] = 'ER_BASE64_DECODE_ERROR';
exports[1576] = 'ER_EVENT_RECURSION_FORBIDDEN';
exports[1577] = 'ER_EVENTS_DB_ERROR';
exports[1578] = 'ER_ONLY_INTEGERS_ALLOWED';
exports[1579] = 'ER_UNSUPORTED_LOG_ENGINE';
exports[1580] = 'ER_BAD_LOG_STATEMENT';
exports[1581] = 'ER_CANT_RENAME_LOG_TABLE';
exports[1582] = 'ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT';
exports[1583] = 'ER_WRONG_PARAMETERS_TO_NATIVE_FCT';
exports[1584] = 'ER_WRONG_PARAMETERS_TO_STORED_FCT';
exports[1585] = 'ER_NATIVE_FCT_NAME_COLLISION';
exports[1586] = 'ER_DUP_ENTRY_WITH_KEY_NAME';
exports[1587] = 'ER_BINLOG_PURGE_EMFILE';
exports[1588] = 'ER_EVENT_CANNOT_CREATE_IN_THE_PAST';
exports[1589] = 'ER_EVENT_CANNOT_ALTER_IN_THE_PAST';
exports[1590] = 'ER_SLAVE_INCIDENT';
exports[1591] = 'ER_NO_PARTITION_FOR_GIVEN_VALUE_SILENT';
exports[1592] = 'ER_BINLOG_UNSAFE_STATEMENT';
exports[1593] = 'ER_SLAVE_FATAL_ERROR';
exports[1594] = 'ER_SLAVE_RELAY_LOG_READ_FAILURE';
exports[1595] = 'ER_SLAVE_RELAY_LOG_WRITE_FAILURE';
exports[1596] = 'ER_SLAVE_CREATE_EVENT_FAILURE';
exports[1597] = 'ER_SLAVE_MASTER_COM_FAILURE';
exports[1598] = 'ER_BINLOG_LOGGING_IMPOSSIBLE';
exports[1599] = 'ER_VIEW_NO_CREATION_CTX';
exports[1600] = 'ER_VIEW_INVALID_CREATION_CTX';
exports[1601] = 'ER_SR_INVALID_CREATION_CTX';
exports[1602] = 'ER_TRG_CORRUPTED_FILE';
exports[1603] = 'ER_TRG_NO_CREATION_CTX';
exports[1604] = 'ER_TRG_INVALID_CREATION_CTX';
exports[1605] = 'ER_EVENT_INVALID_CREATION_CTX';
exports[1606] = 'ER_TRG_CANT_OPEN_TABLE';
exports[1607] = 'ER_CANT_CREATE_SROUTINE';
exports[1608] = 'ER_NEVER_USED';
exports[1609] = 'ER_NO_FORMAT_DESCRIPTION_EVENT_BEFORE_BINLOG_STATEMENT';
exports[1610] = 'ER_SLAVE_CORRUPT_EVENT';
exports[1611] = 'ER_LOAD_DATA_INVALID_COLUMN';
exports[1612] = 'ER_LOG_PURGE_NO_FILE';
exports[1613] = 'ER_XA_RBTIMEOUT';
exports[1614] = 'ER_XA_RBDEADLOCK';
exports[1615] = 'ER_NEED_REPREPARE';
exports[1616] = 'ER_DELAYED_NOT_SUPPORTED';
exports[1617] = 'WARN_NO_MASTER_INFO';
exports[1618] = 'WARN_OPTION_IGNORED';
exports[1619] = 'WARN_PLUGIN_DELETE_BUILTIN';
exports[1620] = 'WARN_PLUGIN_BUSY';
exports[1621] = 'ER_VARIABLE_IS_READONLY';
exports[1622] = 'ER_WARN_ENGINE_TRANSACTION_ROLLBACK';
exports[1623] = 'ER_SLAVE_HEARTBEAT_FAILURE';
exports[1624] = 'ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE';
exports[1625] = 'ER_NDB_REPLICATION_SCHEMA_ERROR';
exports[1626] = 'ER_CONFLICT_FN_PARSE_ERROR';
exports[1627] = 'ER_EXCEPTIONS_WRITE_ERROR';
exports[1628] = 'ER_TOO_LONG_TABLE_COMMENT';
exports[1629] = 'ER_TOO_LONG_FIELD_COMMENT';
exports[1630] = 'ER_FUNC_INEXISTENT_NAME_COLLISION';
exports[1631] = 'ER_DATABASE_NAME';
exports[1632] = 'ER_TABLE_NAME';
exports[1633] = 'ER_PARTITION_NAME';
exports[1634] = 'ER_SUBPARTITION_NAME';
exports[1635] = 'ER_TEMPORARY_NAME';
exports[1636] = 'ER_RENAMED_NAME';
exports[1637] = 'ER_TOO_MANY_CONCURRENT_TRXS';
exports[1638] = 'WARN_NON_ASCII_SEPARATOR_NOT_IMPLEMENTED';
exports[1639] = 'ER_DEBUG_SYNC_TIMEOUT';
exports[1640] = 'ER_DEBUG_SYNC_HIT_LIMIT';
exports[1641] = 'ER_DUP_SIGNAL_SET';
exports[1642] = 'ER_SIGNAL_WARN';
exports[1643] = 'ER_SIGNAL_NOT_FOUND';
exports[1644] = 'ER_SIGNAL_EXCEPTION';
exports[1645] = 'ER_RESIGNAL_WITHOUT_ACTIVE_HANDLER';
exports[1646] = 'ER_SIGNAL_BAD_CONDITION_TYPE';
exports[1647] = 'WARN_COND_ITEM_TRUNCATED';
exports[1648] = 'ER_COND_ITEM_TOO_LONG';
exports[1649] = 'ER_UNKNOWN_LOCALE';
exports[1650] = 'ER_SLAVE_IGNORE_SERVER_IDS';
exports[1651] = 'ER_QUERY_CACHE_DISABLED';
exports[1652] = 'ER_SAME_NAME_PARTITION_FIELD';
exports[1653] = 'ER_PARTITION_COLUMN_LIST_ERROR';
exports[1654] = 'ER_WRONG_TYPE_COLUMN_VALUE_ERROR';
exports[1655] = 'ER_TOO_MANY_PARTITION_FUNC_FIELDS_ERROR';
exports[1656] = 'ER_MAXVALUE_IN_VALUES_IN';
exports[1657] = 'ER_TOO_MANY_VALUES_ERROR';
exports[1658] = 'ER_ROW_SINGLE_PARTITION_FIELD_ERROR';
exports[1659] = 'ER_FIELD_TYPE_NOT_ALLOWED_AS_PARTITION_FIELD';
exports[1660] = 'ER_PARTITION_FIELDS_TOO_LONG';
exports[1661] = 'ER_BINLOG_ROW_ENGINE_AND_STMT_ENGINE';
exports[1662] = 'ER_BINLOG_ROW_MODE_AND_STMT_ENGINE';
exports[1663] = 'ER_BINLOG_UNSAFE_AND_STMT_ENGINE';
exports[1664] = 'ER_BINLOG_ROW_INJECTION_AND_STMT_ENGINE';
exports[1665] = 'ER_BINLOG_STMT_MODE_AND_ROW_ENGINE';
exports[1666] = 'ER_BINLOG_ROW_INJECTION_AND_STMT_MODE';
exports[1667] = 'ER_BINLOG_MULTIPLE_ENGINES_AND_SELF_LOGGING_ENGINE';
exports[1668] = 'ER_BINLOG_UNSAFE_LIMIT';
exports[1669] = 'ER_BINLOG_UNSAFE_INSERT_DELAYED';
exports[1670] = 'ER_BINLOG_UNSAFE_SYSTEM_TABLE';
exports[1671] = 'ER_BINLOG_UNSAFE_AUTOINC_COLUMNS';
exports[1672] = 'ER_BINLOG_UNSAFE_UDF';
exports[1673] = 'ER_BINLOG_UNSAFE_SYSTEM_VARIABLE';
exports[1674] = 'ER_BINLOG_UNSAFE_SYSTEM_FUNCTION';
exports[1675] = 'ER_BINLOG_UNSAFE_NONTRANS_AFTER_TRANS';
exports[1676] = 'ER_MESSAGE_AND_STATEMENT';
exports[1677] = 'ER_SLAVE_CONVERSION_FAILED';
exports[1678] = 'ER_SLAVE_CANT_CREATE_CONVERSION';
exports[1679] = 'ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_BINLOG_FORMAT';
exports[1680] = 'ER_PATH_LENGTH';
exports[1681] = 'ER_WARN_DEPRECATED_SYNTAX_NO_REPLACEMENT';
exports[1682] = 'ER_WRONG_NATIVE_TABLE_STRUCTURE';
exports[1683] = 'ER_WRONG_PERFSCHEMA_USAGE';
exports[1684] = 'ER_WARN_I_S_SKIPPED_TABLE';
exports[1685] = 'ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_BINLOG_DIRECT';
exports[1686] = 'ER_STORED_FUNCTION_PREVENTS_SWITCH_BINLOG_DIRECT';
exports[1687] = 'ER_SPATIAL_MUST_HAVE_GEOM_COL';
exports[1688] = 'ER_TOO_LONG_INDEX_COMMENT';
exports[1689] = 'ER_LOCK_ABORTED';
exports[1690] = 'ER_DATA_OUT_OF_RANGE';
exports[1691] = 'ER_WRONG_SPVAR_TYPE_IN_LIMIT';
exports[1692] = 'ER_BINLOG_UNSAFE_MULTIPLE_ENGINES_AND_SELF_LOGGING_ENGINE';
exports[1693] = 'ER_BINLOG_UNSAFE_MIXED_STATEMENT';
exports[1694] = 'ER_INSIDE_TRANSACTION_PREVENTS_SWITCH_SQL_LOG_BIN';
exports[1695] = 'ER_STORED_FUNCTION_PREVENTS_SWITCH_SQL_LOG_BIN';
exports[1696] = 'ER_FAILED_READ_FROM_PAR_FILE';
exports[1697] = 'ER_VALUES_IS_NOT_INT_TYPE_ERROR';
exports[1698] = 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR';
exports[1699] = 'ER_SET_PASSWORD_AUTH_PLUGIN';
exports[1700] = 'ER_GRANT_PLUGIN_USER_EXISTS';
exports[1701] = 'ER_TRUNCATE_ILLEGAL_FK';
exports[1702] = 'ER_PLUGIN_IS_PERMANENT';
exports[1703] = 'ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE_MIN';
exports[1704] = 'ER_SLAVE_HEARTBEAT_VALUE_OUT_OF_RANGE_MAX';
exports[1705] = 'ER_STMT_CACHE_FULL';
exports[1706] = 'ER_MULTI_UPDATE_KEY_CONFLICT';
exports[1707] = 'ER_TABLE_NEEDS_REBUILD';
exports[1708] = 'WARN_OPTION_BELOW_LIMIT';
exports[1709] = 'ER_INDEX_COLUMN_TOO_LONG';
exports[1710] = 'ER_ERROR_IN_TRIGGER_BODY';
exports[1711] = 'ER_ERROR_IN_UNKNOWN_TRIGGER_BODY';
exports[1712] = 'ER_INDEX_CORRUPT';
exports[1713] = 'ER_UNDO_RECORD_TOO_BIG';
exports[1714] = 'ER_BINLOG_UNSAFE_INSERT_IGNORE_SELECT';
exports[1715] = 'ER_BINLOG_UNSAFE_INSERT_SELECT_UPDATE';
exports[1716] = 'ER_BINLOG_UNSAFE_REPLACE_SELECT';
exports[1717] = 'ER_BINLOG_UNSAFE_CREATE_IGNORE_SELECT';
exports[1718] = 'ER_BINLOG_UNSAFE_CREATE_REPLACE_SELECT';
exports[1719] = 'ER_BINLOG_UNSAFE_UPDATE_IGNORE';
exports[1720] = 'ER_PLUGIN_NO_UNINSTALL';
exports[1721] = 'ER_PLUGIN_NO_INSTALL';
exports[1722] = 'ER_BINLOG_UNSAFE_WRITE_AUTOINC_SELECT';
exports[1723] = 'ER_BINLOG_UNSAFE_CREATE_SELECT_AUTOINC';
exports[1724] = 'ER_BINLOG_UNSAFE_INSERT_TWO_KEYS';
exports[1725] = 'ER_TABLE_IN_FK_CHECK';
exports[1726] = 'ER_UNSUPPORTED_ENGINE';
exports[1727] = 'ER_BINLOG_UNSAFE_AUTOINC_NOT_FIRST';
exports[1728] = 'ER_CANNOT_LOAD_FROM_TABLE_V2';
exports[1729] = 'ER_MASTER_DELAY_VALUE_OUT_OF_RANGE';
exports[1730] = 'ER_ONLY_FD_AND_RBR_EVENTS_ALLOWED_IN_BINLOG_STATEMENT';
exports[1731] = 'ER_PARTITION_EXCHANGE_DIFFERENT_OPTION';
exports[1732] = 'ER_PARTITION_EXCHANGE_PART_TABLE';
exports[1733] = 'ER_PARTITION_EXCHANGE_TEMP_TABLE';
exports[1734] = 'ER_PARTITION_INSTEAD_OF_SUBPARTITION';
exports[1735] = 'ER_UNKNOWN_PARTITION';
exports[1736] = 'ER_TABLES_DIFFERENT_METADATA';
exports[1737] = 'ER_ROW_DOES_NOT_MATCH_PARTITION';
exports[1738] = 'ER_BINLOG_CACHE_SIZE_GREATER_THAN_MAX';
exports[1739] = 'ER_WARN_INDEX_NOT_APPLICABLE';
exports[1740] = 'ER_PARTITION_EXCHANGE_FOREIGN_KEY';
exports[1741] = 'ER_NO_SUCH_KEY_VALUE';
exports[1742] = 'ER_RPL_INFO_DATA_TOO_LONG';
exports[1743] = 'ER_NETWORK_READ_EVENT_CHECKSUM_FAILURE';
exports[1744] = 'ER_BINLOG_READ_EVENT_CHECKSUM_FAILURE';
exports[1745] = 'ER_BINLOG_STMT_CACHE_SIZE_GREATER_THAN_MAX';
exports[1746] = 'ER_CANT_UPDATE_TABLE_IN_CREATE_TABLE_SELECT';
exports[1747] = 'ER_PARTITION_CLAUSE_ON_NONPARTITIONED';
exports[1748] = 'ER_ROW_DOES_NOT_MATCH_GIVEN_PARTITION_SET';
exports[1749] = 'ER_NO_SUCH_PARTITION';
exports[1750] = 'ER_CHANGE_RPL_INFO_REPOSITORY_FAILURE';
exports[1751] = 'ER_WARNING_NOT_COMPLETE_ROLLBACK_WITH_CREATED_TEMP_TABLE';
exports[1752] = 'ER_WARNING_NOT_COMPLETE_ROLLBACK_WITH_DROPPED_TEMP_TABLE';
exports[1753] = 'ER_MTS_FEATURE_IS_NOT_SUPPORTED';
exports[1754] = 'ER_MTS_UPDATED_DBS_GREATER_MAX';
exports[1755] = 'ER_MTS_CANT_PARALLEL';
exports[1756] = 'ER_MTS_INCONSISTENT_DATA';
exports[1757] = 'ER_FULLTEXT_NOT_SUPPORTED_WITH_PARTITIONING';
exports[1758] = 'ER_DA_INVALID_CONDITION_NUMBER';
exports[1759] = 'ER_INSECURE_PLAIN_TEXT';
exports[1760] = 'ER_INSECURE_CHANGE_MASTER';
exports[1761] = 'ER_FOREIGN_DUPLICATE_KEY_WITH_CHILD_INFO';
exports[1762] = 'ER_FOREIGN_DUPLICATE_KEY_WITHOUT_CHILD_INFO';
exports[1763] = 'ER_SQLTHREAD_WITH_SECURE_SLAVE';
exports[1764] = 'ER_TABLE_HAS_NO_FT';
exports[1765] = 'ER_VARIABLE_NOT_SETTABLE_IN_SF_OR_TRIGGER';
exports[1766] = 'ER_VARIABLE_NOT_SETTABLE_IN_TRANSACTION';
exports[1767] = 'ER_GTID_NEXT_IS_NOT_IN_GTID_NEXT_LIST';
exports[1768] =
  'ER_CANT_CHANGE_GTID_NEXT_IN_TRANSACTION_WHEN_GTID_NEXT_LIST_IS_NULL';
exports[1769] = 'ER_SET_STATEMENT_CANNOT_INVOKE_FUNCTION';
exports[1770] = 'ER_GTID_NEXT_CANT_BE_AUTOMATIC_IF_GTID_NEXT_LIST_IS_NON_NULL';
exports[1771] = 'ER_SKIPPING_LOGGED_TRANSACTION';
exports[1772] = 'ER_MALFORMED_GTID_SET_SPECIFICATION';
exports[1773] = 'ER_MALFORMED_GTID_SET_ENCODING';
exports[1774] = 'ER_MALFORMED_GTID_SPECIFICATION';
exports[1775] = 'ER_GNO_EXHAUSTED';
exports[1776] = 'ER_BAD_SLAVE_AUTO_POSITION';
exports[1777] = 'ER_AUTO_POSITION_REQUIRES_GTID_MODE_ON';
exports[1778] = 'ER_CANT_DO_IMPLICIT_COMMIT_IN_TRX_WHEN_GTID_NEXT_IS_SET';
exports[1779] = 'ER_GTID_MODE_2_OR_3_REQUIRES_ENFORCE_GTID_CONSISTENCY_ON';
exports[1780] = 'ER_GTID_MODE_REQUIRES_BINLOG';
exports[1781] = 'ER_CANT_SET_GTID_NEXT_TO_GTID_WHEN_GTID_MODE_IS_OFF';
exports[1782] = 'ER_CANT_SET_GTID_NEXT_TO_ANONYMOUS_WHEN_GTID_MODE_IS_ON';
exports[1783] = 'ER_CANT_SET_GTID_NEXT_LIST_TO_NON_NULL_WHEN_GTID_MODE_IS_OFF';
exports[1784] = 'ER_FOUND_GTID_EVENT_WHEN_GTID_MODE_IS_OFF';
exports[1785] = 'ER_GTID_UNSAFE_NON_TRANSACTIONAL_TABLE';
exports[1786] = 'ER_GTID_UNSAFE_CREATE_SELECT';
exports[1787] = 'ER_GTID_UNSAFE_CREATE_DROP_TEMPORARY_TABLE_IN_TRANSACTION';
exports[1788] = 'ER_GTID_MODE_CAN_ONLY_CHANGE_ONE_STEP_AT_A_TIME';
exports[1789] = 'ER_MASTER_HAS_PURGED_REQUIRED_GTIDS';
exports[1790] = 'ER_CANT_SET_GTID_NEXT_WHEN_OWNING_GTID';
exports[1791] = 'ER_UNKNOWN_EXPLAIN_FORMAT';
exports[1792] = 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION';
exports[1793] = 'ER_TOO_LONG_TABLE_PARTITION_COMMENT';
exports[1794] = 'ER_SLAVE_CONFIGURATION';
exports[1795] = 'ER_INNODB_FT_LIMIT';
exports[1796] = 'ER_INNODB_NO_FT_TEMP_TABLE';
exports[1797] = 'ER_INNODB_FT_WRONG_DOCID_COLUMN';
exports[1798] = 'ER_INNODB_FT_WRONG_DOCID_INDEX';
exports[1799] = 'ER_INNODB_ONLINE_LOG_TOO_BIG';
exports[1800] = 'ER_UNKNOWN_ALTER_ALGORITHM';
exports[1801] = 'ER_UNKNOWN_ALTER_LOCK';
exports[1802] = 'ER_MTS_CHANGE_MASTER_CANT_RUN_WITH_GAPS';
exports[1803] = 'ER_MTS_RECOVERY_FAILURE';
exports[1804] = 'ER_MTS_RESET_WORKERS';
exports[1805] = 'ER_COL_COUNT_DOESNT_MATCH_CORRUPTED_V2';
exports[1806] = 'ER_SLAVE_SILENT_RETRY_TRANSACTION';
exports[1807] = 'ER_DISCARD_FK_CHECKS_RUNNING';
exports[1808] = 'ER_TABLE_SCHEMA_MISMATCH';
exports[1809] = 'ER_TABLE_IN_SYSTEM_TABLESPACE';
exports[1810] = 'ER_IO_READ_ERROR';
exports[1811] = 'ER_IO_WRITE_ERROR';
exports[1812] = 'ER_TABLESPACE_MISSING';
exports[1813] = 'ER_TABLESPACE_EXISTS';
exports[1814] = 'ER_TABLESPACE_DISCARDED';
exports[1815] = 'ER_INTERNAL_ERROR';
exports[1816] = 'ER_INNODB_IMPORT_ERROR';
exports[1817] = 'ER_INNODB_INDEX_CORRUPT';
exports[1818] = 'ER_INVALID_YEAR_COLUMN_LENGTH';
exports[1819] = 'ER_NOT_VALID_PASSWORD';
exports[1820] = 'ER_MUST_CHANGE_PASSWORD';
exports[1821] = 'ER_FK_NO_INDEX_CHILD';
exports[1822] = 'ER_FK_NO_INDEX_PARENT';
exports[1823] = 'ER_FK_FAIL_ADD_SYSTEM';
exports[1824] = 'ER_FK_CANNOT_OPEN_PARENT';
exports[1825] = 'ER_FK_INCORRECT_OPTION';
exports[1826] = 'ER_FK_DUP_NAME';
exports[1827] = 'ER_PASSWORD_FORMAT';
exports[1828] = 'ER_FK_COLUMN_CANNOT_DROP';
exports[1829] = 'ER_FK_COLUMN_CANNOT_DROP_CHILD';
exports[1830] = 'ER_FK_COLUMN_NOT_NULL';
exports[1831] = 'ER_DUP_INDEX';
exports[1832] = 'ER_FK_COLUMN_CANNOT_CHANGE';
exports[1833] = 'ER_FK_COLUMN_CANNOT_CHANGE_CHILD';
exports[1834] = 'ER_FK_CANNOT_DELETE_PARENT';
exports[1835] = 'ER_MALFORMED_PACKET';
exports[1836] = 'ER_READ_ONLY_MODE';
exports[1837] = 'ER_GTID_NEXT_TYPE_UNDEFINED_GROUP';
exports[1838] = 'ER_VARIABLE_NOT_SETTABLE_IN_SP';
exports[1839] = 'ER_CANT_SET_GTID_PURGED_WHEN_GTID_MODE_IS_OFF';
exports[1840] = 'ER_CANT_SET_GTID_PURGED_WHEN_GTID_EXECUTED_IS_NOT_EMPTY';
exports[1841] = 'ER_CANT_SET_GTID_PURGED_WHEN_OWNED_GTIDS_IS_NOT_EMPTY';
exports[1842] = 'ER_GTID_PURGED_WAS_CHANGED';
exports[1843] = 'ER_GTID_EXECUTED_WAS_CHANGED';
exports[1844] = 'ER_BINLOG_STMT_MODE_AND_NO_REPL_TABLES';
exports[1845] = 'ER_ALTER_OPERATION_NOT_SUPPORTED';
exports[1846] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON';
exports[1847] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_COPY';
exports[1848] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_PARTITION';
exports[1849] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FK_RENAME';
exports[1850] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_COLUMN_TYPE';
exports[1851] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FK_CHECK';
exports[1852] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_IGNORE';
exports[1853] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_NOPK';
exports[1854] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_AUTOINC';
exports[1855] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_HIDDEN_FTS';
exports[1856] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_CHANGE_FTS';
exports[1857] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_FTS';
exports[1858] = 'ER_SQL_SLAVE_SKIP_COUNTER_NOT_SETTABLE_IN_GTID_MODE';
exports[1859] = 'ER_DUP_UNKNOWN_IN_INDEX';
exports[1860] = 'ER_IDENT_CAUSES_TOO_LONG_PATH';
exports[1861] = 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON_NOT_NULL';
exports[1862] = 'ER_MUST_CHANGE_PASSWORD_LOGIN';
exports[1863] = 'ER_ROW_IN_WRONG_PARTITION';
exports[1864] = 'ER_MTS_EVENT_BIGGER_PENDING_JOBS_SIZE_MAX';
exports[1865] = 'ER_INNODB_NO_FT_USES_PARSER';
exports[1866] = 'ER_BINLOG_LOGICAL_CORRUPTION';
exports[1867] = 'ER_WARN_PURGE_LOG_IN_USE';
exports[1868] = 'ER_WARN_PURGE_LOG_IS_ACTIVE';
exports[1869] = 'ER_AUTO_INCREMENT_CONFLICT';
exports[1870] = 'WARN_ON_BLOCKHOLE_IN_RBR';
exports[1871] = 'ER_SLAVE_MI_INIT_REPOSITORY';
exports[1872] = 'ER_SLAVE_RLI_INIT_REPOSITORY';
exports[1873] = 'ER_ACCESS_DENIED_CHANGE_USER_ERROR';
exports[1874] = 'ER_INNODB_READ_ONLY';
exports[1875] = 'ER_STOP_SLAVE_SQL_THREAD_TIMEOUT';
exports[1876] = 'ER_STOP_SLAVE_IO_THREAD_TIMEOUT';
exports[1877] = 'ER_TABLE_CORRUPT';
exports[1878] = 'ER_TEMP_FILE_WRITE_FAILURE';
exports[1879] = 'ER_INNODB_FT_AUX_NOT_HEX_ID';
exports[1880] = 'ER_OLD_TEMPORALS_UPGRADED';
exports[1881] = 'ER_INNODB_FORCED_RECOVERY';
exports[1882] = 'ER_AES_INVALID_IV';

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528777, function(require, module, exports) {


const Iconv = require('iconv-lite');

exports.decode = function(buffer, encoding, options) {
  if (Buffer.isEncoding(encoding)) {
    return buffer.toString(encoding);
  }

  const decoder = Iconv.getDecoder(encoding, options || {});

  const res = decoder.write(buffer);
  const trail = decoder.end();

  return trail ? res + trail : res;
};

exports.encode = function(string, encoding, options) {
  if (Buffer.isEncoding(encoding)) {
    return Buffer.from(string, encoding);
  }

  const encoder = Iconv.getEncoder(encoding, options || {});

  const res = encoder.write(string);
  const trail = encoder.end();

  return trail && trail.length > 0 ? Buffer.concat([res, trail]) : res;
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528778, function(require, module, exports) {


const process = require('process');

const AuthSwitchRequest = require('./auth_switch_request');
const AuthSwitchRequestMoreData = require('./auth_switch_request_more_data');
const AuthSwitchResponse = require('./auth_switch_response');
const BinaryRow = require('./binary_row');
const BinlogDump = require('./binlog_dump');
const ChangeUser = require('./change_user');
const CloseStatement = require('./close_statement');
const ColumnDefinition = require('./column_definition');
const Execute = require('./execute');
const Handshake = require('./handshake');
const HandshakeResponse = require('./handshake_response');
const PrepareStatement = require('./prepare_statement');
const PreparedStatementHeader = require('./prepared_statement_header');
const Query = require('./query');
const RegisterSlave = require('./register_slave');
const ResultSetHeader = require('./resultset_header');
const SSLRequest = require('./ssl_request');
const TextRow = require('./text_row');

const ctorMap = {
  AuthSwitchRequest,
  AuthSwitchRequestMoreData,
  AuthSwitchResponse,
  BinaryRow,
  BinlogDump,
  ChangeUser,
  CloseStatement,
  ColumnDefinition,
  Execute,
  Handshake,
  HandshakeResponse,
  PrepareStatement,
  PreparedStatementHeader,
  Query,
  RegisterSlave,
  ResultSetHeader,
  SSLRequest,
  TextRow
};
Object.entries(ctorMap).forEach(([name, ctor]) => {
  module.exports[name] = ctor;
  // monkey-patch it to include name if debug is on
  if (process.env.NODE_DEBUG) {
    if (ctor.prototype.toPacket) {
      const old = ctor.prototype.toPacket;
      ctor.prototype.toPacket = function() {
        const p = old.call(this);
        p._name = name;
        return p;
      };
    }
  }
});

// simple packets:
const Packet = require('./packet');
exports.Packet = Packet;

class OK {
  static toPacket(args, encoding) {
    args = args || {};
    const affectedRows = args.affectedRows || 0;
    const insertId = args.insertId || 0;
    const serverStatus = args.serverStatus || 0;
    const warningCount = args.warningCount || 0;
    const message = args.message || '';

    let length = 9 + Packet.lengthCodedNumberLength(affectedRows);
    length += Packet.lengthCodedNumberLength(insertId);

    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(0);
    packet.writeLengthCodedNumber(affectedRows);
    packet.writeLengthCodedNumber(insertId);
    packet.writeInt16(serverStatus);
    packet.writeInt16(warningCount);
    packet.writeString(message, encoding);
    packet._name = 'OK';
    return packet;
  }
}

exports.OK = OK;

// warnings, statusFlags
class EOF {
  static toPacket(warnings, statusFlags) {
    if (typeof warnings === 'undefined') {
      warnings = 0;
    }
    if (typeof statusFlags === 'undefined') {
      statusFlags = 0;
    }
    const packet = new Packet(0, Buffer.allocUnsafe(9), 0, 9);
    packet.offset = 4;
    packet.writeInt8(0xfe);
    packet.writeInt16(warnings);
    packet.writeInt16(statusFlags);
    packet._name = 'EOF';
    return packet;
  }
}

exports.EOF = EOF;

class Error {
  static toPacket(args, encoding) {
    const length = 13 + Buffer.byteLength(args.message, 'utf8');
    const packet = new Packet(0, Buffer.allocUnsafe(length), 0, length);
    packet.offset = 4;
    packet.writeInt8(0xff);
    packet.writeInt16(args.code);
    // TODO: sql state parameter
    packet.writeString('#_____', encoding);
    packet.writeString(args.message, encoding);
    packet._name = 'Error';
    return packet;
  }
}

exports.Error = Error;

}, function(modId) { var map = {"./auth_switch_request":1619928528779,"./auth_switch_request_more_data":1619928528780,"./auth_switch_response":1619928528781,"./binary_row":1619928528782,"./binlog_dump":1619928528784,"./change_user":1619928528786,"./close_statement":1619928528790,"./column_definition":1619928528791,"./execute":1619928528792,"./handshake":1619928528794,"./handshake_response":1619928528795,"./prepare_statement":1619928528796,"./prepared_statement_header":1619928528797,"./query":1619928528798,"./register_slave":1619928528799,"./resultset_header":1619928528800,"./ssl_request":1619928528804,"./text_row":1619928528805,"./packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528779, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::AuthSwitchRequest

const Packet = require('../packets/packet');

class AuthSwitchRequest {
  constructor(opts) {
    this.pluginName = opts.pluginName;
    this.pluginData = opts.pluginData;
  }

  toPacket() {
    const length = 6 + this.pluginName.length + this.pluginData.length;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(0xfe);
    // TODO: use server encoding
    packet.writeNullTerminatedString(this.pluginName, 'cesu8');
    packet.writeBuffer(this.pluginData);
    return packet;
  }

  static fromPacket(packet) {
    packet.readInt8(); // marker
    // assert marker == 0xfe?
    // TODO: use server encoding
    const name = packet.readNullTerminatedString('cesu8');
    const data = packet.readBuffer();
    return new AuthSwitchRequest({
      pluginName: name,
      pluginData: data
    });
  }
}

module.exports = AuthSwitchRequest;

}, function(modId) { var map = {"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528780, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::AuthSwitchRequest

const Packet = require('../packets/packet');

class AuthSwitchRequestMoreData {
  constructor(data) {
    this.data = data;
  }

  toPacket() {
    const length = 5 + this.data.length;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(0x01);
    packet.writeBuffer(this.data);
    return packet;
  }

  static fromPacket(packet) {
    packet.readInt8(); // marker
    const data = packet.readBuffer();
    return new AuthSwitchRequestMoreData(data);
  }

  static verifyMarker(packet) {
    return packet.peekByte() === 0x01;
  }
}

module.exports = AuthSwitchRequestMoreData;

}, function(modId) { var map = {"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528781, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::AuthSwitchRequest

const Packet = require('../packets/packet');

class AuthSwitchResponse {
  constructor(data) {
    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data);
    }
    this.data = data;
  }

  toPacket() {
    const length = 4 + this.data.length;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeBuffer(this.data);
    return packet;
  }

  static fromPacket(packet) {
    const data = packet.readBuffer();
    return new AuthSwitchResponse(data);
  }
}

module.exports = AuthSwitchResponse;

}, function(modId) { var map = {"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528782, function(require, module, exports) {


const Types = require('../constants/types');
const Packet = require('../packets/packet');

const binaryReader = new Array(256);

class BinaryRow {
  constructor(columns) {
    this.columns = columns || [];
  }

  toPacket() {
    throw new Error('Not implemented');
  }

  // TODO: complete list of types...
  static fromPacket(fields, packet) {
    const columns = new Array(fields.length);
    packet.readInt8(); // TODO check it's 0
    const nullBitmapLength = Math.floor((fields.length + 7 + 2) / 8);
    // TODO: read and interpret null bitmap
    packet.skip(nullBitmapLength);
    for (let i = 0; i < columns.length; ++i) {
      columns[i] = binaryReader[fields[i].columnType].apply(packet);
    }
    return new BinaryRow(columns);
  }
}

// TODO: replace with constants.MYSQL_TYPE_*
binaryReader[Types.DECIMAL] = Packet.prototype.readLengthCodedString;
binaryReader[1] = Packet.prototype.readInt8; // tiny
binaryReader[2] = Packet.prototype.readInt16; // short
binaryReader[3] = Packet.prototype.readInt32; // long
binaryReader[4] = Packet.prototype.readFloat; // float
binaryReader[5] = Packet.prototype.readDouble; // double
binaryReader[6] = Packet.prototype.assertInvalid; // null, should be skipped vie null bitmap
binaryReader[7] = Packet.prototype.readTimestamp; // timestamp, http://dev.mysql.com/doc/internals/en/prepared-statements.html#packet-ProtocolBinary::MYSQL_TYPE_TIMESTAMP
binaryReader[8] = Packet.prototype.readInt64; // long long
binaryReader[9] = Packet.prototype.readInt32; // int24
binaryReader[10] = Packet.prototype.readTimestamp; // date
binaryReader[11] = Packet.prototype.readTime; // time, http://dev.mysql.com/doc/internals/en/prepared-statements.html#packet-ProtocolBinary::MYSQL_TYPE_TIME
binaryReader[12] = Packet.prototype.readDateTime; // datetime, http://dev.mysql.com/doc/internals/en/prepared-statements.html#packet-ProtocolBinary::MYSQL_TYPE_DATETIME
binaryReader[13] = Packet.prototype.readInt16; // year
binaryReader[Types.VAR_STRING] = Packet.prototype.readLengthCodedString; // var string

module.exports = BinaryRow;

}, function(modId) { var map = {"../constants/types":1619928528783,"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528783, function(require, module, exports) {


// Manually extracted from mysql-5.5.23/include/mysql_com.h
// some more info here: http://dev.mysql.com/doc/refman/5.5/en/c-api-prepared-statement-type-codes.html
exports.DECIMAL = 0x00; // aka DECIMAL (http://dev.mysql.com/doc/refman/5.0/en/precision-math-decimal-changes.html)
exports.TINY = 0x01; // aka TINYINT, 1 byte
exports.SHORT = 0x02; // aka SMALLINT, 2 bytes
exports.LONG = 0x03; // aka INT, 4 bytes
exports.FLOAT = 0x04; // aka FLOAT, 4-8 bytes
exports.DOUBLE = 0x05; // aka DOUBLE, 8 bytes
exports.NULL = 0x06; // NULL (used for prepared statements, I think)
exports.TIMESTAMP = 0x07; // aka TIMESTAMP
exports.LONGLONG = 0x08; // aka BIGINT, 8 bytes
exports.INT24 = 0x09; // aka MEDIUMINT, 3 bytes
exports.DATE = 0x0a; // aka DATE
exports.TIME = 0x0b; // aka TIME
exports.DATETIME = 0x0c; // aka DATETIME
exports.YEAR = 0x0d; // aka YEAR, 1 byte (don't ask)
exports.NEWDATE = 0x0e; // aka ?
exports.VARCHAR = 0x0f; // aka VARCHAR (?)
exports.BIT = 0x10; // aka BIT, 1-8 byte
exports.JSON = 0xf5;
exports.NEWDECIMAL = 0xf6; // aka DECIMAL
exports.ENUM = 0xf7; // aka ENUM
exports.SET = 0xf8; // aka SET
exports.TINY_BLOB = 0xf9; // aka TINYBLOB, TINYTEXT
exports.MEDIUM_BLOB = 0xfa; // aka MEDIUMBLOB, MEDIUMTEXT
exports.LONG_BLOB = 0xfb; // aka LONGBLOG, LONGTEXT
exports.BLOB = 0xfc; // aka BLOB, TEXT
exports.VAR_STRING = 0xfd; // aka VARCHAR, VARBINARY
exports.STRING = 0xfe; // aka CHAR, BINARY
exports.GEOMETRY = 0xff; // aka GEOMETRY

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528784, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/com-binlog-dump.html#packet-COM_BINLOG_DUMP

const Packet = require('../packets/packet');
const CommandCodes = require('../constants/commands');

// TODO: add flag to constants
// 0x01 - BINLOG_DUMP_NON_BLOCK
// send EOF instead of blocking
class BinlogDump {
  constructor(opts) {
    this.binlogPos = opts.binlogPos || 0;
    this.serverId = opts.serverId || 0;
    this.flags = opts.flags || 0;
    this.filename = opts.filename || '';
  }

  toPacket() {
    const length = 15 + Buffer.byteLength(this.filename, 'utf8'); // TODO: should be ascii?
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(CommandCodes.BINLOG_DUMP);
    packet.writeInt32(this.binlogPos);
    packet.writeInt16(this.flags);
    packet.writeInt32(this.serverId);
    packet.writeString(this.filename);
    return packet;
  }
}

module.exports = BinlogDump;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../constants/commands":1619928528785}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528785, function(require, module, exports) {


module.exports = {
  SLEEP: 0x00, // deprecated
  QUIT: 0x01,
  INIT_DB: 0x02,
  QUERY: 0x03,
  FIELD_LIST: 0x04,
  CREATE_DB: 0x05,
  DROP_DB: 0x06,
  REFRESH: 0x07,
  SHUTDOWN: 0x08,
  STATISTICS: 0x09,
  PROCESS_INFO: 0x0a, // deprecated
  CONNECT: 0x0b, // deprecated
  PROCESS_KILL: 0x0c,
  DEBUG: 0x0d,
  PING: 0x0e,
  TIME: 0x0f, // deprecated
  DELAYED_INSERT: 0x10, // deprecated
  CHANGE_USER: 0x11,
  BINLOG_DUMP: 0x12,
  TABLE_DUMP: 0x13,
  CONNECT_OUT: 0x14,
  REGISTER_SLAVE: 0x15,
  STMT_PREPARE: 0x16,
  STMT_EXECUTE: 0x17,
  STMT_SEND_LONG_DATA: 0x18,
  STMT_CLOSE: 0x19,
  STMT_RESET: 0x1a,
  SET_OPTION: 0x1b,
  STMT_FETCH: 0x1c,
  DAEMON: 0x1d, // deprecated
  BINLOG_DUMP_GTID: 0x1e,
  UNKNOWN: 0xff // bad!
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528786, function(require, module, exports) {


const CommandCode = require('../constants/commands.js');
const ClientConstants = require('../constants/client.js');
const Packet = require('../packets/packet.js');
const auth41 = require('../auth_41.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');

// https://dev.mysql.com/doc/internals/en/com-change-user.html#packet-COM_CHANGE_USER
class ChangeUser {
  constructor(opts) {
    this.flags = opts.flags;
    this.user = opts.user || '';
    this.database = opts.database || '';
    this.password = opts.password || '';
    this.passwordSha1 = opts.passwordSha1;
    this.authPluginData1 = opts.authPluginData1;
    this.authPluginData2 = opts.authPluginData2;
    this.connectAttributes = opts.connectAttrinutes || {};
    let authToken;
    if (this.passwordSha1) {
      authToken = auth41.calculateTokenFromPasswordSha(
        this.passwordSha1,
        this.authPluginData1,
        this.authPluginData2
      );
    } else {
      authToken = auth41.calculateToken(
        this.password,
        this.authPluginData1,
        this.authPluginData2
      );
    }
    this.authToken = authToken;
    this.charsetNumber = opts.charsetNumber;
  }

  // TODO
  // ChangeUser.fromPacket = function(packet)
  // };
  serializeToBuffer(buffer) {
    const isSet = flag => this.flags & ClientConstants[flag];
    const packet = new Packet(0, buffer, 0, buffer.length);
    packet.offset = 4;
    const encoding = CharsetToEncoding[this.charsetNumber];
    packet.writeInt8(CommandCode.CHANGE_USER);
    packet.writeNullTerminatedString(this.user, encoding);
    if (isSet('SECURE_CONNECTION')) {
      packet.writeInt8(this.authToken.length);
      packet.writeBuffer(this.authToken);
    } else {
      packet.writeBuffer(this.authToken);
      packet.writeInt8(0);
    }
    packet.writeNullTerminatedString(this.database, encoding);
    packet.writeInt16(this.charsetNumber);
    if (isSet('PLUGIN_AUTH')) {
      // TODO: read this from parameters
      packet.writeNullTerminatedString('mysql_native_password', 'latin1');
    }
    if (isSet('CONNECT_ATTRS')) {
      const connectAttributes = this.connectAttributes;
      const attrNames = Object.keys(connectAttributes);
      let keysLength = 0;
      for (let k = 0; k < attrNames.length; ++k) {
        keysLength += Packet.lengthCodedStringLength(attrNames[k], encoding);
        keysLength += Packet.lengthCodedStringLength(
          connectAttributes[attrNames[k]],
          encoding
        );
      }
      packet.writeLengthCodedNumber(keysLength);
      for (let k = 0; k < attrNames.length; ++k) {
        packet.writeLengthCodedString(attrNames[k], encoding);
        packet.writeLengthCodedString(
          connectAttributes[attrNames[k]],
          encoding
        );
      }
    }
    return packet;
  }

  toPacket() {
    if (typeof this.user !== 'string') {
      throw new Error('"user" connection config property must be a string');
    }
    if (typeof this.database !== 'string') {
      throw new Error('"database" connection config property must be a string');
    }
    // dry run: calculate resulting packet length
    const p = this.serializeToBuffer(Packet.MockBuffer());
    return this.serializeToBuffer(Buffer.allocUnsafe(p.offset));
  }
}

module.exports = ChangeUser;

}, function(modId) { var map = {"../constants/commands.js":1619928528785,"../constants/client.js":1619928528787,"../packets/packet.js":1619928528775,"../auth_41.js":1619928528788,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528787, function(require, module, exports) {


// Manually extracted from mysql-5.5.23/include/mysql_com.h
exports.LONG_PASSWORD = 0x00000001; /* new more secure passwords */
exports.FOUND_ROWS = 0x00000002; /* found instead of affected rows */
exports.LONG_FLAG = 0x00000004; /* get all column flags */
exports.CONNECT_WITH_DB = 0x00000008; /* one can specify db on connect */
exports.NO_SCHEMA = 0x00000010; /* don't allow database.table.column */
exports.COMPRESS = 0x00000020; /* can use compression protocol */
exports.ODBC = 0x00000040; /* odbc client */
exports.LOCAL_FILES = 0x00000080; /* can use LOAD DATA LOCAL */
exports.IGNORE_SPACE = 0x00000100; /* ignore spaces before '' */
exports.PROTOCOL_41 = 0x00000200; /* new 4.1 protocol */
exports.INTERACTIVE = 0x00000400; /* this is an interactive client */
exports.SSL = 0x00000800; /* switch to ssl after handshake */
exports.IGNORE_SIGPIPE = 0x00001000; /* IGNORE sigpipes */
exports.TRANSACTIONS = 0x00002000; /* client knows about transactions */
exports.RESERVED = 0x00004000; /* old flag for 4.1 protocol  */
exports.SECURE_CONNECTION = 0x00008000; /* new 4.1 authentication */
exports.MULTI_STATEMENTS = 0x00010000; /* enable/disable multi-stmt support */
exports.MULTI_RESULTS = 0x00020000; /* enable/disable multi-results */
exports.PS_MULTI_RESULTS = 0x00040000; /* multi-results in ps-protocol */
exports.PLUGIN_AUTH = 0x00080000; /* client supports plugin authentication */
exports.CONNECT_ATTRS = 0x00100000; /* permits connection attributes */
exports.PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000; /* Understands length-encoded integer for auth response data in Protocol::HandshakeResponse41. */
exports.CAN_HANDLE_EXPIRED_PASSWORDS = 0x00400000; /* Announces support for expired password extension. */
exports.SESSION_TRACK = 0x00800000; /* Can set SERVER_SESSION_STATE_CHANGED in the Status Flags and send session-state change data after a OK packet. */
exports.DEPRECATE_EOF = 0x01000000; /* Can send OK after a Text Resultset. */

exports.SSL_VERIFY_SERVER_CERT = 0x40000000;
exports.REMEMBER_OPTIONS = 0x80000000;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528788, function(require, module, exports) {


/*
4.1 authentication: (http://bazaar.launchpad.net/~mysql/mysql-server/5.5/view/head:/sql/password.c)

  SERVER:  public_seed=create_random_string()
           send(public_seed)

  CLIENT:  recv(public_seed)
           hash_stage1=sha1("password")
           hash_stage2=sha1(hash_stage1)
           reply=xor(hash_stage1, sha1(public_seed,hash_stage2)

           // this three steps are done in scramble()

           send(reply)


  SERVER:  recv(reply)
           hash_stage1=xor(reply, sha1(public_seed,hash_stage2))
           candidate_hash2=sha1(hash_stage1)
           check(candidate_hash2==hash_stage2)

server stores sha1(sha1(password)) ( hash_stag2)
*/

const crypto = require('crypto');

function sha1(msg, msg1, msg2) {
  const hash = crypto.createHash('sha1');
  hash.update(msg);
  if (msg1) {
    hash.update(msg1);
  }

  if (msg2) {
    hash.update(msg2);
  }

  return hash.digest();
}

function xor(a, b) {
  if (!Buffer.isBuffer(a)) {
    a = Buffer.from(a, 'binary');
  }

  if (!Buffer.isBuffer(b)) {
    b = Buffer.from(b, 'binary');
  }

  const result = Buffer.allocUnsafe(a.length);

  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

exports.xor = xor;

function token(password, scramble1, scramble2) {
  // TODO: use buffers (not sure why strings here)
  if (!password) {
    return Buffer.alloc(0);
  }
  const stage1 = sha1(password);
  return exports.calculateTokenFromPasswordSha(stage1, scramble1, scramble2);
}

exports.calculateTokenFromPasswordSha = function(
  passwordSha,
  scramble1,
  scramble2
) {
  // we use AUTH 41 here, and we need only the bytes we just need.
  const authPluginData1 = scramble1.slice(0, 8);
  const authPluginData2 = scramble2.slice(0, 12);
  const stage2 = sha1(passwordSha);
  const stage3 = sha1(authPluginData1, authPluginData2, stage2);
  return xor(stage3, passwordSha);
};

exports.calculateToken = token;

exports.verifyToken = function(publicSeed1, publicSeed2, token, doubleSha) {
  const hashStage1 = xor(token, sha1(publicSeed1, publicSeed2, doubleSha));
  const candidateHash2 = sha1(hashStage1);
  return candidateHash2.compare(doubleSha) === 0;
};

exports.doubleSha1 = function(password) {
  return sha1(sha1(password));
};

function xorRotating(a, seed) {
  if (!Buffer.isBuffer(a)) {
    a = Buffer.from(a, 'binary');
  }

  if (!Buffer.isBuffer(seed)) {
    seed = Buffer.from(seed, 'binary');
  }

  const result = Buffer.allocUnsafe(a.length);
  const seedLen = seed.length;

  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ seed[i % seedLen];
  }
  return result;
}
exports.xorRotating = xorRotating;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528789, function(require, module, exports) {


// see tools/generate-charset-mapping.js
// basicalliy result of "SHOW COLLATION" query

module.exports = [
  'utf8',
  'big5',
  'latin2',
  'dec8',
  'cp850',
  'latin1',
  'hp8',
  'koi8r',
  'latin1',
  'latin2',
  'swe7',
  'ascii',
  'eucjp',
  'sjis',
  'cp1251',
  'latin1',
  'hebrew',
  'utf8',
  'tis620',
  'euckr',
  'latin7',
  'latin2',
  'koi8u',
  'cp1251',
  'gb2312',
  'greek',
  'cp1250',
  'latin2',
  'gbk',
  'cp1257',
  'latin5',
  'latin1',
  'armscii8',
  'cesu8',
  'cp1250',
  'ucs2',
  'cp866',
  'keybcs2',
  'macintosh',
  'macroman',
  'cp852',
  'latin7',
  'latin7',
  'macintosh',
  'cp1250',
  'utf8',
  'utf8',
  'latin1',
  'latin1',
  'latin1',
  'cp1251',
  'cp1251',
  'cp1251',
  'macroman',
  'utf16',
  'utf16',
  'utf16-le',
  'cp1256',
  'cp1257',
  'cp1257',
  'utf32',
  'utf32',
  'utf16-le',
  'binary',
  'armscii8',
  'ascii',
  'cp1250',
  'cp1256',
  'cp866',
  'dec8',
  'greek',
  'hebrew',
  'hp8',
  'keybcs2',
  'koi8r',
  'koi8u',
  'cesu8',
  'latin2',
  'latin5',
  'latin7',
  'cp850',
  'cp852',
  'swe7',
  'cesu8',
  'big5',
  'euckr',
  'gb2312',
  'gbk',
  'sjis',
  'tis620',
  'ucs2',
  'eucjp',
  'geostd8',
  'geostd8',
  'latin1',
  'cp932',
  'cp932',
  'eucjpms',
  'eucjpms',
  'cp1250',
  'utf8',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf16',
  'utf8',
  'utf8',
  'utf8',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'ucs2',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'ucs2',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf32',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'cesu8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'cesu8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'gb18030',
  'gb18030',
  'gb18030',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8',
  'utf8'
];

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528790, function(require, module, exports) {


const Packet = require('../packets/packet');
const CommandCodes = require('../constants/commands');

class CloseStatement {
  constructor(id) {
    this.id = id;
  }

  // note: no response sent back
  toPacket() {
    const packet = new Packet(0, Buffer.allocUnsafe(9), 0, 9);
    packet.offset = 4;
    packet.writeInt8(CommandCodes.STMT_CLOSE);
    packet.writeInt32(this.id);
    return packet;
  }
}

module.exports = CloseStatement;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../constants/commands":1619928528785}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528791, function(require, module, exports) {


const Packet = require('../packets/packet');
const StringParser = require('../parsers/string');
const CharsetToEncoding = require('../constants/charset_encodings.js');

const fields = ['catalog', 'schema', 'table', 'orgTable', 'name', 'orgName'];

// creating JS string is relatively expensive (compared to
// reading few bytes from buffer) because all string properties
// except for name are unlikely to be used we postpone
// string conversion until property access
//
// TODO: watch for integration benchmarks (one with real network buffer)
// there could be bad side effect as keeping reference to a buffer makes it
// sit in the memory longer (usually until final .query() callback)
// Latest v8 perform much better in regard to bufferer -> string conversion,
// at some point of time this optimisation might become unnecessary
// see https://github.com/sidorares/node-mysql2/pull/137
//
class ColumnDefinition {
  constructor(packet, clientEncoding) {
    this._buf = packet.buffer;
    this._clientEncoding = clientEncoding;
    this._catalogLength = packet.readLengthCodedNumber();
    this._catalogStart = packet.offset;
    packet.offset += this._catalogLength;
    this._schemaLength = packet.readLengthCodedNumber();
    this._schemaStart = packet.offset;
    packet.offset += this._schemaLength;
    this._tableLength = packet.readLengthCodedNumber();
    this._tableStart = packet.offset;
    packet.offset += this._tableLength;
    this._orgTableLength = packet.readLengthCodedNumber();
    this._orgTableStart = packet.offset;
    packet.offset += this._orgTableLength;
    // name is always used, don't make it lazy
    const _nameLength = packet.readLengthCodedNumber();
    const _nameStart = packet.offset;
    packet.offset += _nameLength;
    this._orgNameLength = packet.readLengthCodedNumber();
    this._orgNameStart = packet.offset;
    packet.offset += this._orgNameLength;
    packet.skip(1); //  length of the following fields (always 0x0c)
    this.characterSet = packet.readInt16();
    this.encoding = CharsetToEncoding[this.characterSet];
    this.name = StringParser.decode(
      this._buf.slice(_nameStart, _nameStart + _nameLength),
      this.encoding === 'binary' ? this._clientEncoding : this.encoding
    );
    this.columnLength = packet.readInt32();
    this.columnType = packet.readInt8();
    this.flags = packet.readInt16();
    this.decimals = packet.readInt8();
  }

  inspect() {
    return {
      catalog: this.catalog,
      schema: this.schema,
      name: this.name,
      orgName: this.orgName,
      table: this.table,
      orgTable: this.orgTable,
      characterSet: this.characterSet,
      columnLength: this.columnLength,
      columnType: this.columnType,
      flags: this.flags,
      decimals: this.decimals
    };
  }

  static toPacket(column, sequenceId) {
    let length = 17; // = 4 padding + 1 + 12 for the rest
    fields.forEach(field => {
      length += Packet.lengthCodedStringLength(
        column[field],
        CharsetToEncoding[column.characterSet]
      );
    });
    const buffer = Buffer.allocUnsafe(length);

    const packet = new Packet(sequenceId, buffer, 0, length);
    function writeField(name) {
      packet.writeLengthCodedString(
        column[name],
        CharsetToEncoding[column.characterSet]
      );
    }
    packet.offset = 4;
    fields.forEach(writeField);
    packet.writeInt8(0x0c);
    packet.writeInt16(column.characterSet);
    packet.writeInt32(column.columnLength);
    packet.writeInt8(column.columnType);
    packet.writeInt16(column.flags);
    packet.writeInt8(column.decimals);
    packet.writeInt16(0); // filler
    return packet;
  }

  // node-mysql compatibility: alias "db" to "schema"
  get db() {
    const start = this._schemaStart;
    const end = start._shemaLength;
    return this._buf.utf8Slice(start, end);
  }
}

const addString = function(name) {
  Object.defineProperty(ColumnDefinition.prototype, name, {
    get: function() {
      const start = this[`_${name}Start`];
      const end = start + this[`_${name}Length`];
      return StringParser.decode(
        this._buf.slice(start, end),
        this.encoding === 'binary' ? this._clientEncoding : this.encoding
      );
    }
  });
};

addString('catalog');
addString('schema');
addString('table');
addString('orgTable');
addString('orgName');

module.exports = ColumnDefinition;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../parsers/string":1619928528777,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528792, function(require, module, exports) {


const CursorType = require('../constants/cursor');
const CommandCodes = require('../constants/commands');
const Types = require('../constants/types');
const Packet = require('../packets/packet');
const CharsetToEncoding = require('../constants/charset_encodings.js');

function isJSON(value) {
  return (
    Array.isArray(value) ||
    value.constructor === Object ||
    (typeof value.toJSON === 'function' && !Buffer.isBuffer(value))
  );
}

/**
 * Converts a value to an object describing type, String/Buffer representation and length
 * @param {*} value
 */
function toParameter(value, encoding, timezone) {
  let type = Types.VAR_STRING;
  let length;
  let writer = function(value) {
    // eslint-disable-next-line no-invalid-this
    return Packet.prototype.writeLengthCodedString.call(this, value, encoding);
  };
  if (value !== null) {
    switch (typeof value) {
      case 'undefined':
        throw new TypeError('Bind parameters must not contain undefined');

      case 'number':
        type = Types.DOUBLE;
        length = 8;
        writer = Packet.prototype.writeDouble;
        break;

      case 'boolean':
        value = value | 0;
        type = Types.TINY;
        length = 1;
        writer = Packet.prototype.writeInt8;
        break;

      case 'object':
        if (Object.prototype.toString.call(value) === '[object Date]') {
          type = Types.DATETIME;
          length = 12;
          writer = function(value) {
            // eslint-disable-next-line no-invalid-this
            return Packet.prototype.writeDate.call(this, value, timezone);
          };
        } else if (isJSON(value)) {
          value = JSON.stringify(value);
          type = Types.JSON;
        } else if (Buffer.isBuffer(value)) {
          length = Packet.lengthCodedNumberLength(value.length) + value.length;
          writer = Packet.prototype.writeLengthCodedBuffer;
        }
        break;

      default:
        value = value.toString();
    }
  } else {
    value = '';
    type = Types.NULL;
  }
  if (!length) {
    length = Packet.lengthCodedStringLength(value, encoding);
  }
  return { value, type, length, writer };
}

class Execute {
  constructor(id, parameters, charsetNumber, timezone) {
    this.id = id;
    this.parameters = parameters;
    this.encoding = CharsetToEncoding[charsetNumber];
    this.timezone = timezone;
  }

  toPacket() {
    // TODO: don't try to calculate packet length in advance, allocate some big buffer in advance (header + 256 bytes?)
    // and copy + reallocate if not enough
    // 0 + 4 - length, seqId
    // 4 + 1 - COM_EXECUTE
    // 5 + 4 - stmtId
    // 9 + 1 - flags
    // 10 + 4 - iteration-count (always 1)
    let length = 14;
    let parameters;
    if (this.parameters && this.parameters.length > 0) {
      length += Math.floor((this.parameters.length + 7) / 8);
      length += 1; // new-params-bound-flag
      length += 2 * this.parameters.length; // type byte for each parameter if new-params-bound-flag is set
      parameters = this.parameters.map(value =>
        toParameter(value, this.encoding, this.timezone)
      );
      length += parameters.reduce(
        (accumulator, parameter) => accumulator + parameter.length,
        0
      );
    }
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(CommandCodes.STMT_EXECUTE);
    packet.writeInt32(this.id);
    packet.writeInt8(CursorType.NO_CURSOR); // flags
    packet.writeInt32(1); // iteration-count, always 1
    if (parameters) {
      let bitmap = 0;
      let bitValue = 1;
      parameters.forEach(parameter => {
        if (parameter.type === Types.NULL) {
          bitmap += bitValue;
        }
        bitValue *= 2;
        if (bitValue === 256) {
          packet.writeInt8(bitmap);
          bitmap = 0;
          bitValue = 1;
        }
      });
      if (bitValue !== 1) {
        packet.writeInt8(bitmap);
      }
      // TODO: explain meaning of the flag
      // afaik, if set n*2 bytes with type of parameter are sent before parameters
      // if not, previous execution types are used (TODO prooflink)
      packet.writeInt8(1); // new-params-bound-flag
      // Write parameter types
      parameters.forEach(parameter => {
        packet.writeInt8(parameter.type); // field type
        packet.writeInt8(0); // parameter flag
      });
      // Write parameter values
      parameters.forEach(parameter => {
        if (parameter.type !== Types.NULL) {
          parameter.writer.call(packet, parameter.value);
        }
      });
    }
    return packet;
  }
}

module.exports = Execute;

}, function(modId) { var map = {"../constants/cursor":1619928528793,"../constants/commands":1619928528785,"../constants/types":1619928528783,"../packets/packet":1619928528775,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528793, function(require, module, exports) {


module.exports = {
  NO_CURSOR: 0,
  READ_ONLY: 1,
  FOR_UPDATE: 2,
  SCROLLABLE: 3
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528794, function(require, module, exports) {


const Packet = require('../packets/packet');
const ClientConstants = require('../constants/client.js');

// https://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::Handshake

class Handshake {
  constructor(args) {
    this.protocolVersion = args.protocolVersion;
    this.serverVersion = args.serverVersion;
    this.capabilityFlags = args.capabilityFlags;
    this.connectionId = args.connectionId;
    this.authPluginData1 = args.authPluginData1;
    this.authPluginData2 = args.authPluginData2;
    this.characterSet = args.characterSet;
    this.statusFlags = args.statusFlags;
    this.autPluginName = args.autPluginName;
  }

  setScrambleData(cb) {
    require('crypto').randomBytes(20, (err, data) => {
      if (err) {
        cb(err);
        return;
      }
      this.authPluginData1 = data.slice(0, 8);
      this.authPluginData2 = data.slice(8, 20);
      cb();
    });
  }

  toPacket(sequenceId) {
    const length = 68 + Buffer.byteLength(this.serverVersion, 'utf8');
    const buffer = Buffer.alloc(length + 4, 0); // zero fill, 10 bytes filler later needs to contain zeros
    const packet = new Packet(sequenceId, buffer, 0, length + 4);
    packet.offset = 4;
    packet.writeInt8(this.protocolVersion);
    packet.writeString(this.serverVersion, 'cesu8');
    packet.writeInt8(0);
    packet.writeInt32(this.connectionId);
    packet.writeBuffer(this.authPluginData1);
    packet.writeInt8(0);
    const capabilityFlagsBuffer = Buffer.allocUnsafe(4);
    capabilityFlagsBuffer.writeUInt32LE(this.capabilityFlags, 0);
    packet.writeBuffer(capabilityFlagsBuffer.slice(0, 2));
    packet.writeInt8(this.characterSet);
    packet.writeInt16(this.statusFlags);
    packet.writeBuffer(capabilityFlagsBuffer.slice(2, 4));
    packet.writeInt8(21); // authPluginDataLength
    packet.skip(10);
    packet.writeBuffer(this.authPluginData2);
    packet.writeInt8(0);
    packet.writeString('mysql_native_password', 'latin1');
    packet.writeInt8(0);
    return packet;
  }

  static fromPacket(packet) {
    const args = {};
    args.protocolVersion = packet.readInt8();
    args.serverVersion = packet.readNullTerminatedString('cesu8');
    args.connectionId = packet.readInt32();
    args.authPluginData1 = packet.readBuffer(8);
    packet.skip(1);
    const capabilityFlagsBuffer = Buffer.allocUnsafe(4);
    capabilityFlagsBuffer[0] = packet.readInt8();
    capabilityFlagsBuffer[1] = packet.readInt8();
    if (packet.haveMoreData()) {
      args.characterSet = packet.readInt8();
      args.statusFlags = packet.readInt16();
      // upper 2 bytes
      capabilityFlagsBuffer[2] = packet.readInt8();
      capabilityFlagsBuffer[3] = packet.readInt8();
      args.capabilityFlags = capabilityFlagsBuffer.readUInt32LE(0);
      if (args.capabilityFlags & ClientConstants.PLUGIN_AUTH) {
        args.authPluginDataLength = packet.readInt8();
      } else {
        args.authPluginDataLength = 0;
        packet.skip(1);
      }
      packet.skip(10);
    } else {
      args.capabilityFlags = capabilityFlagsBuffer.readUInt16LE(0);
    }

    const isSecureConnection =
      args.capabilityFlags & ClientConstants.SECURE_CONNECTION;
    if (isSecureConnection) {
      const authPluginDataLength = args.authPluginDataLength;
      if (authPluginDataLength === 0) {
        // for Secure Password Authentication
        args.authPluginDataLength = 20;
        args.authPluginData2 = packet.readBuffer(12);
        packet.skip(1);
      } else {
        // length > 0
        // for Custom Auth Plugin (PLUGIN_AUTH)
        const len = Math.max(13, authPluginDataLength - 8);
        args.authPluginData2 = packet.readBuffer(len);
      }
    }

    if (args.capabilityFlags & ClientConstants.PLUGIN_AUTH) {
      args.autPluginName = packet.readNullTerminatedString('ascii');
    }

    return new Handshake(args);
  }
}

module.exports = Handshake;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../constants/client.js":1619928528787}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528795, function(require, module, exports) {


const ClientConstants = require('../constants/client.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');
const Packet = require('../packets/packet.js');

const auth41 = require('../auth_41.js');

class HandshakeResponse {
  constructor(handshake) {
    this.user = handshake.user || '';
    this.database = handshake.database || '';
    this.password = handshake.password || '';
    this.passwordSha1 = handshake.passwordSha1;
    this.authPluginData1 = handshake.authPluginData1;
    this.authPluginData2 = handshake.authPluginData2;
    this.compress = handshake.compress;
    this.clientFlags = handshake.flags;
    // TODO: pre-4.1 auth support
    let authToken;
    if (this.passwordSha1) {
      authToken = auth41.calculateTokenFromPasswordSha(
        this.passwordSha1,
        this.authPluginData1,
        this.authPluginData2
      );
    } else {
      authToken = auth41.calculateToken(
        this.password,
        this.authPluginData1,
        this.authPluginData2
      );
    }
    this.authToken = authToken;
    this.charsetNumber = handshake.charsetNumber;
    this.encoding = CharsetToEncoding[handshake.charsetNumber];
    this.connectAttributes = handshake.connectAttributes;
  }

  serializeResponse(buffer) {
    const isSet = flag => this.clientFlags & ClientConstants[flag];
    const packet = new Packet(0, buffer, 0, buffer.length);
    packet.offset = 4;
    packet.writeInt32(this.clientFlags);
    packet.writeInt32(0); // max packet size. todo: move to config
    packet.writeInt8(this.charsetNumber);
    packet.skip(23);
    const encoding = this.encoding;
    packet.writeNullTerminatedString(this.user, encoding);
    let k;
    if (isSet('PLUGIN_AUTH_LENENC_CLIENT_DATA')) {
      packet.writeLengthCodedNumber(this.authToken.length);
      packet.writeBuffer(this.authToken);
    } else if (isSet('SECURE_CONNECTION')) {
      packet.writeInt8(this.authToken.length);
      packet.writeBuffer(this.authToken);
    } else {
      packet.writeBuffer(this.authToken);
      packet.writeInt8(0);
    }
    if (isSet('CONNECT_WITH_DB')) {
      packet.writeNullTerminatedString(this.database, encoding);
    }
    if (isSet('PLUGIN_AUTH')) {
      // TODO: pass from config
      packet.writeNullTerminatedString('mysql_native_password', 'latin1');
    }
    if (isSet('CONNECT_ATTRS')) {
      const connectAttributes = this.connectAttributes || {};
      const attrNames = Object.keys(connectAttributes);
      let keysLength = 0;
      for (k = 0; k < attrNames.length; ++k) {
        keysLength += Packet.lengthCodedStringLength(attrNames[k], encoding);
        keysLength += Packet.lengthCodedStringLength(
          connectAttributes[attrNames[k]],
          encoding
        );
      }
      packet.writeLengthCodedNumber(keysLength);
      for (k = 0; k < attrNames.length; ++k) {
        packet.writeLengthCodedString(attrNames[k], encoding);
        packet.writeLengthCodedString(
          connectAttributes[attrNames[k]],
          encoding
        );
      }
    }
    return packet;
  }

  toPacket() {
    if (typeof this.user !== 'string') {
      throw new Error('"user" connection config property must be a string');
    }
    if (typeof this.database !== 'string') {
      throw new Error('"database" connection config property must be a string');
    }
    // dry run: calculate resulting packet length
    const p = this.serializeResponse(Packet.MockBuffer());
    return this.serializeResponse(Buffer.alloc(p.offset));
  }
  static fromPacket(packet) {
    const args = {};
    args.clientFlags = packet.readInt32();
    function isSet(flag) {
      return args.clientFlags & ClientConstants[flag];
    }
    args.maxPacketSize = packet.readInt32();
    args.charsetNumber = packet.readInt8();
    const encoding = CharsetToEncoding[args.charsetNumber];
    args.encoding = encoding;
    packet.skip(23);
    args.user = packet.readNullTerminatedString(encoding);
    let authTokenLength;
    if (isSet('PLUGIN_AUTH_LENENC_CLIENT_DATA')) {
      authTokenLength = packet.readLengthCodedNumber(encoding);
      args.authToken = packet.readBuffer(authTokenLength);
    } else if (isSet('SECURE_CONNECTION')) {
      authTokenLength = packet.readInt8();
      args.authToken = packet.readBuffer(authTokenLength);
    } else {
      args.authToken = packet.readNullTerminatedString(encoding);
    }
    if (isSet('CONNECT_WITH_DB')) {
      args.database = packet.readNullTerminatedString(encoding);
    }
    if (isSet('PLUGIN_AUTH')) {
      args.authPluginName = packet.readNullTerminatedString(encoding);
    }
    if (isSet('CONNECT_ATTRS')) {
      const keysLength = packet.readLengthCodedNumber(encoding);
      const keysEnd = packet.offset + keysLength;
      const attrs = {};
      while (packet.offset < keysEnd) {
        attrs[
          packet.readLengthCodedString(encoding)
        ] = packet.readLengthCodedString(encoding);
      }
      args.connectAttributes = attrs;
    }
    return args;
  }
}

module.exports = HandshakeResponse;

}, function(modId) { var map = {"../constants/client.js":1619928528787,"../constants/charset_encodings.js":1619928528789,"../packets/packet.js":1619928528775,"../auth_41.js":1619928528788}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528796, function(require, module, exports) {


const Packet = require('../packets/packet');
const CommandCodes = require('../constants/commands');
const StringParser = require('../parsers/string.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');

class PrepareStatement {
  constructor(sql, charsetNumber) {
    this.query = sql;
    this.charsetNumber = charsetNumber;
    this.encoding = CharsetToEncoding[charsetNumber];
  }

  toPacket() {
    const buf = StringParser.encode(this.query, this.encoding);
    const length = 5 + buf.length;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(CommandCodes.STMT_PREPARE);
    packet.writeBuffer(buf);
    return packet;
  }
}

module.exports = PrepareStatement;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../constants/commands":1619928528785,"../parsers/string.js":1619928528777,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528797, function(require, module, exports) {


class PreparedStatementHeader {
  constructor(packet) {
    packet.skip(1); // should be 0
    this.id = packet.readInt32();
    this.fieldCount = packet.readInt16();
    this.parameterCount = packet.readInt16();
    packet.skip(1); // should be 0
    this.warningCount = packet.readInt16();
  }
}

// TODO: toPacket

module.exports = PreparedStatementHeader;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528798, function(require, module, exports) {


const Packet = require('../packets/packet.js');
const CommandCode = require('../constants/commands.js');
const StringParser = require('../parsers/string.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');

class Query {
  constructor(sql, charsetNumber) {
    this.query = sql;
    this.charsetNumber = charsetNumber;
    this.encoding = CharsetToEncoding[charsetNumber];
  }

  toPacket() {
    const buf = StringParser.encode(this.query, this.encoding);
    const length = 5 + buf.length;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(CommandCode.QUERY);
    packet.writeBuffer(buf);
    return packet;
  }
}

module.exports = Query;

}, function(modId) { var map = {"../packets/packet.js":1619928528775,"../constants/commands.js":1619928528785,"../parsers/string.js":1619928528777,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528799, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/com-register-slave.html
// note that documentation is incorrect, for example command code is actually 0x15 but documented as 0x14

const Packet = require('../packets/packet');
const CommandCodes = require('../constants/commands');

class RegisterSlave {
  constructor(opts) {
    this.serverId = opts.serverId || 0;
    this.slaveHostname = opts.slaveHostname || '';
    this.slaveUser = opts.slaveUser || '';
    this.slavePassword = opts.slavePassword || '';
    this.slavePort = opts.slavePort || 0;
    this.replicationRank = opts.replicationRank || 0;
    this.masterId = opts.masterId || 0;
  }

  toPacket() {
    const length =
      15 + // TODO: should be ascii?
      Buffer.byteLength(this.slaveHostname, 'utf8') +
      Buffer.byteLength(this.slaveUser, 'utf8') +
      Buffer.byteLength(this.slavePassword, 'utf8') +
      3 +
      4;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeInt8(CommandCodes.REGISTER_SLAVE);
    packet.writeInt32(this.serverId);
    packet.writeInt8(Buffer.byteLength(this.slaveHostname, 'utf8'));
    packet.writeString(this.slaveHostname);
    packet.writeInt8(Buffer.byteLength(this.slaveUser, 'utf8'));
    packet.writeString(this.slaveUser);
    packet.writeInt8(Buffer.byteLength(this.slavePassword, 'utf8'));
    packet.writeString(this.slavePassword);
    packet.writeInt16(this.slavePort);
    packet.writeInt32(this.replicationRank);
    packet.writeInt32(this.masterId);
    return packet;
  }
}

module.exports = RegisterSlave;

}, function(modId) { var map = {"../packets/packet":1619928528775,"../constants/commands":1619928528785}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528800, function(require, module, exports) {


// TODO: rename to OK packet
// https://dev.mysql.com/doc/internals/en/packet-OK_Packet.html

const Packet = require('./packet.js');
const ClientConstants = require('../constants/client.js');
const ServerSatusFlags = require('../constants/server_status.js');

const EncodingToCharset = require('../constants/encoding_charset.js');
const sessionInfoTypes = require('../constants/session_track.js');

class ResultSetHeader {
  constructor(packet, connection) {
    const bigNumberStrings = connection.config.bigNumberStrings;
    const encoding = connection.serverEncoding;
    const flags = connection._handshakePacket.capabilityFlags;
    const isSet = function(flag) {
      return flags & ClientConstants[flag];
    };
    if (packet.buffer[packet.offset] !== 0) {
      this.fieldCount = packet.readLengthCodedNumber();
      if (this.fieldCount === null) {
        this.infileName = packet.readString(undefined, encoding);
      }
      return;
    }
    this.fieldCount = packet.readInt8(); // skip OK byte
    this.affectedRows = packet.readLengthCodedNumber(bigNumberStrings);
    this.insertId = packet.readLengthCodedNumberSigned(bigNumberStrings);
    this.info = '';
    if (isSet('PROTOCOL_41')) {
      this.serverStatus = packet.readInt16();
      this.warningStatus = packet.readInt16();
    } else if (isSet('TRANSACTIONS')) {
      this.serverStatus = packet.readInt16();
    }
    let stateChanges = null;
    if (isSet('SESSION_TRACK') && packet.offset < packet.end) {
      this.info = packet.readLengthCodedString(encoding);

      if (this.serverStatus && ServerSatusFlags.SERVER_SESSION_STATE_CHANGED) {
        // session change info record - see
        // https://dev.mysql.com/doc/internals/en/packet-OK_Packet.html#cs-sect-packet-ok-sessioninfo
        let len =
          packet.offset < packet.end ? packet.readLengthCodedNumber() : 0;
        const end = packet.offset + len;
        let type, key, stateEnd;
        if (len > 0) {
          stateChanges = {
            systemVariables: {},
            schema: null,
            trackStateChange: null
          };
        }
        while (packet.offset < end) {
          type = packet.readInt8();
          len = packet.readLengthCodedNumber();
          stateEnd = packet.offset + len;
          if (type === sessionInfoTypes.SYSTEM_VARIABLES) {
            key = packet.readLengthCodedString(encoding);
            const val = packet.readLengthCodedString(encoding);
            stateChanges.systemVariables[key] = val;
            if (key === 'character_set_client') {
              const charsetNumber = EncodingToCharset[val];
              connection.config.charsetNumber = charsetNumber;
            }
          } else if (type === sessionInfoTypes.SCHEMA) {
            key = packet.readLengthCodedString(encoding);
            stateChanges.schema = key;
          } else if (type === sessionInfoTypes.STATE_CHANGE) {
            stateChanges.trackStateChange = packet.readLengthCodedString(
              encoding
            );
          } else {
            // unsupported session track type. For now just ignore
          }
          packet.offset = stateEnd;
        }
      }
    } else {
      this.info = packet.readString(undefined, encoding);
    }
    if (stateChanges) {
      this.stateChanges = stateChanges;
    }
    const m = this.info.match(/\schanged:\s*(\d+)/i);
    if (m !== null) {
      this.changedRows = parseInt(m[1], 10);
    }
  }

  // TODO: should be consistent instance member, but it's just easier here to have just function
  static toPacket(fieldCount, insertId) {
    let length = 4 + Packet.lengthCodedNumberLength(fieldCount);
    if (typeof insertId !== 'undefined') {
      length += Packet.lengthCodedNumberLength(insertId);
    }
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    packet.offset = 4;
    packet.writeLengthCodedNumber(fieldCount);
    if (typeof insertId !== 'undefined') {
      packet.writeLengthCodedNumber(insertId);
    }
    return packet;
  }
}

module.exports = ResultSetHeader;

}, function(modId) { var map = {"./packet.js":1619928528775,"../constants/client.js":1619928528787,"../constants/server_status.js":1619928528801,"../constants/encoding_charset.js":1619928528802,"../constants/session_track.js":1619928528803}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528801, function(require, module, exports) {


// Manually extracted from mysql-5.5.23/include/mysql_com.h

/**
  Is raised when a multi-statement transaction
  has been started, either explicitly, by means
  of BEGIN or COMMIT AND CHAIN, or
  implicitly, by the first transactional
  statement, when autocommit=off.
*/
exports.SERVER_STATUS_IN_TRANS = 1;
exports.SERVER_STATUS_AUTOCOMMIT = 2; /* Server in auto_commit mode */
exports.SERVER_MORE_RESULTS_EXISTS = 8; /* Multi query - next query exists */
exports.SERVER_QUERY_NO_GOOD_INDEX_USED = 16;
exports.SERVER_QUERY_NO_INDEX_USED = 32;
/**
  The server was able to fulfill the clients request and opened a
  read-only non-scrollable cursor for a query. This flag comes
  in reply to COM_STMT_EXECUTE and COM_STMT_FETCH commands.
*/
exports.SERVER_STATUS_CURSOR_EXISTS = 64;
/**
  This flag is sent when a read-only cursor is exhausted, in reply to
  COM_STMT_FETCH command.
*/
exports.SERVER_STATUS_LAST_ROW_SENT = 128;
exports.SERVER_STATUS_DB_DROPPED = 256; /* A database was dropped */
exports.SERVER_STATUS_NO_BACKSLASH_ESCAPES = 512;
/**
  Sent to the client if after a prepared statement reprepare
  we discovered that the new statement returns a different
  number of result set columns.
*/
exports.SERVER_STATUS_METADATA_CHANGED = 1024;
exports.SERVER_QUERY_WAS_SLOW = 2048;

/**
  To mark ResultSet containing output parameter values.
*/
exports.SERVER_PS_OUT_PARAMS = 4096;

exports.SERVER_STATUS_IN_TRANS_READONLY = 0x2000; // in a read-only transaction
exports.SERVER_SESSION_STATE_CHANGED = 0x4000;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528802, function(require, module, exports) {


// inverse of charset_encodings
// given encoding, get matching mysql charset number

module.exports = {
  big5: 1,
  latin2: 2,
  dec8: 3,
  cp850: 4,
  latin1: 5,
  hp8: 6,
  koi8r: 7,
  swe7: 10,
  ascii: 11,
  eucjp: 12,
  sjis: 13,
  cp1251: 14,
  hebrew: 16,
  tis620: 18,
  euckr: 19,
  latin7: 20,
  koi8u: 22,
  gb2312: 24,
  greek: 25,
  cp1250: 26,
  gbk: 28,
  cp1257: 29,
  latin5: 30,
  armscii8: 32,
  cesu8: 33,
  ucs2: 35,
  cp866: 36,
  keybcs2: 37,
  macintosh: 38,
  macroman: 39,
  cp852: 40,
  utf8: 45,
  utf8mb4: 45,
  utf16: 54,
  utf16le: 56,
  cp1256: 57,
  utf32: 60,
  binary: 63,
  geostd8: 92,
  cp932: 95,
  eucjpms: 97,
  gb18030: 248
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528803, function(require, module, exports) {


exports.SYSTEM_VARIABLES = 0;
exports.SCHEMA = 1;
exports.STATE_CHANGE = 2;
exports.STATE_GTIDS = 3;
exports.TRANSACTION_CHARACTERISTICS = 4;
exports.TRANSACTION_STATE = 5;

exports.FIRST_KEY = exports.SYSTEM_VARIABLES;
exports.LAST_KEY = exports.TRANSACTION_STATE;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528804, function(require, module, exports) {


const ClientConstants = require('../constants/client');
const Packet = require('../packets/packet');

class SSLRequest {
  constructor(flags, charset) {
    this.clientFlags = flags | ClientConstants.SSL;
    this.charset = charset;
  }

  toPacket() {
    const length = 36;
    const buffer = Buffer.allocUnsafe(length);
    const packet = new Packet(0, buffer, 0, length);
    buffer.fill(0);
    packet.offset = 4;
    packet.writeInt32(this.clientFlags);
    packet.writeInt32(0); // max packet size. todo: move to config
    packet.writeInt8(this.charset);
    return packet;
  }
}

module.exports = SSLRequest;

}, function(modId) { var map = {"../constants/client":1619928528787,"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528805, function(require, module, exports) {


const Packet = require('../packets/packet');

class TextRow {
  constructor(columns) {
    this.columns = columns || [];
  }

  static fromPacket(packet) {
    // packet.reset(); // set offset to starting point?
    const columns = [];
    while (packet.haveMoreData()) {
      columns.push(packet.readLengthCodedString());
    }
    return new TextRow(columns);
  }

  static toPacket(columns, encoding) {
    const sequenceId = 0; // TODO remove, this is calculated now in connecton
    let length = 0;
    columns.forEach(val => {
      if (val === null || typeof val === 'undefined') {
        ++length;
        return;
      }
      length += Packet.lengthCodedStringLength(val.toString(10), encoding);
    });
    const buffer = Buffer.allocUnsafe(length + 4);
    const packet = new Packet(sequenceId, buffer, 0, length + 4);
    packet.offset = 4;
    columns.forEach(val => {
      if (val === null) {
        packet.writeNull();
        return;
      }
      if (typeof val === 'undefined') {
        packet.writeInt8(0);
        return;
      }
      packet.writeLengthCodedString(val.toString(10), encoding);
    });
    return packet;
  }
}

module.exports = TextRow;

}, function(modId) { var map = {"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528806, function(require, module, exports) {


const ClientHandshake = require('./client_handshake.js');
const ServerHandshake = require('./server_handshake.js');
const Query = require('./query.js');
const Prepare = require('./prepare.js');
const CloseStatement = require('./close_statement.js');
const Execute = require('./execute.js');
const Ping = require('./ping.js');
const RegisterSlave = require('./register_slave.js');
const BinlogDump = require('./binlog_dump.js');
const ChangeUser = require('./change_user.js');
const Quit = require('./quit.js');

module.exports = {
  ClientHandshake,
  ServerHandshake,
  Query,
  Prepare,
  CloseStatement,
  Execute,
  Ping,
  RegisterSlave,
  BinlogDump,
  ChangeUser,
  Quit
};

}, function(modId) { var map = {"./client_handshake.js":1619928528807,"./server_handshake.js":1619928528814,"./query.js":1619928528815,"./prepare.js":1619928528820,"./close_statement.js":1619928528821,"./execute.js":1619928528822,"./ping.js":1619928528825,"./register_slave.js":1619928528826,"./binlog_dump.js":1619928528827,"./change_user.js":1619928528829,"./quit.js":1619928528830}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528807, function(require, module, exports) {


const Command = require('./command.js');
const Packets = require('../packets/index.js');
const ClientConstants = require('../constants/client.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');
const auth41 = require('../auth_41.js');

function flagNames(flags) {
  const res = [];
  for (const c in ClientConstants) {
    if (flags & ClientConstants[c]) {
      res.push(c.replace(/_/g, ' ').toLowerCase());
    }
  }
  return res;
}

class ClientHandshake extends Command {
  constructor(clientFlags) {
    super();
    this.handshake = null;
    this.clientFlags = clientFlags;
  }

  start() {
    return ClientHandshake.prototype.handshakeInit;
  }

  sendSSLRequest(connection) {
    const sslRequest = new Packets.SSLRequest(
      this.clientFlags,
      connection.config.charsetNumber
    );
    connection.writePacket(sslRequest.toPacket());
  }

  sendCredentials(connection) {
    if (connection.config.debug) {
      // eslint-disable-next-line
      console.log(
        'Sending handshake packet: flags:%d=(%s)',
        this.clientFlags,
        flagNames(this.clientFlags).join(', ')
      );
    }
    this.user = connection.config.user;
    this.password = connection.config.password;
    this.passwordSha1 = connection.config.passwordSha1;
    this.database = connection.config.database;
    this.autPluginName = this.handshake.autPluginName;
    const handshakeResponse = new Packets.HandshakeResponse({
      flags: this.clientFlags,
      user: this.user,
      database: this.database,
      password: this.password,
      passwordSha1: this.passwordSha1,
      charsetNumber: connection.config.charsetNumber,
      authPluginData1: this.handshake.authPluginData1,
      authPluginData2: this.handshake.authPluginData2,
      compress: connection.config.compress,
      connectAttributes: connection.config.connectAttributes
    });
    connection.writePacket(handshakeResponse.toPacket());
  }

  calculateNativePasswordAuthToken(authPluginData) {
    // TODO: dont split into authPluginData1 and authPluginData2, instead join when 1 & 2 received
    const authPluginData1 = authPluginData.slice(0, 8);
    const authPluginData2 = authPluginData.slice(8, 20);
    let authToken;
    if (this.passwordSha1) {
      authToken = auth41.calculateTokenFromPasswordSha(
        this.passwordSha1,
        authPluginData1,
        authPluginData2
      );
    } else {
      authToken = auth41.calculateToken(
        this.password,
        authPluginData1,
        authPluginData2
      );
    }
    return authToken;
  }

  handshakeInit(helloPacket, connection) {
    this.on('error', e => {
      connection._fatalError = e;
      connection._protocolError = e;
    });
    this.handshake = Packets.Handshake.fromPacket(helloPacket);
    if (connection.config.debug) {
      // eslint-disable-next-line
      console.log(
        'Server hello packet: capability flags:%d=(%s)',
        this.handshake.capabilityFlags,
        flagNames(this.handshake.capabilityFlags).join(', ')
      );
    }
    connection.serverCapabilityFlags = this.handshake.capabilityFlags;
    connection.serverEncoding = CharsetToEncoding[this.handshake.characterSet];
    connection.connectionId = this.handshake.connectionId;
    const serverSSLSupport =
      this.handshake.capabilityFlags & ClientConstants.SSL;
    // use compression only if requested by client and supported by server
    connection.config.compress =
      connection.config.compress &&
      this.handshake.capabilityFlags & ClientConstants.COMPRESS;
    this.clientFlags = this.clientFlags | connection.config.compress;
    if (connection.config.ssl) {
      // client requires SSL but server does not support it
      if (!serverSSLSupport) {
        const err = new Error('Server does not support secure connnection');
        err.code = 'HANDSHAKE_NO_SSL_SUPPORT';
        err.fatal = true;
        this.emit('error', err);
        return false;
      }
      // send ssl upgrade request and immediately upgrade connection to secure
      this.clientFlags |= ClientConstants.SSL;
      this.sendSSLRequest(connection);
      connection.startTLS(err => {
        // after connection is secure
        if (err) {
          // SSL negotiation error are fatal
          err.code = 'HANDSHAKE_SSL_ERROR';
          err.fatal = true;
          this.emit('error', err);
          return;
        }
        // rest of communication is encrypted
        this.sendCredentials(connection);
      });
    } else {
      this.sendCredentials(connection);
    }
    return ClientHandshake.prototype.handshakeResult;
  }

  handshakeResult(packet, connection) {
    const marker = packet.peekByte();
    if (marker === 0xfe || marker === 1) {
      const authSwitch = require('./auth_switch');
      try {
        if (marker === 1) {
          authSwitch.authSwitchRequestMoreData(packet, connection, this);
        } else {
          authSwitch.authSwitchRequest(packet, connection, this);
        }
        return ClientHandshake.prototype.handshakeResult;
      } catch (err) {
        if (this.onResult) {
          this.onResult(err);
        } else {
          connection.emit('error', err);
        }
        return null;
      }
    }
    if (marker !== 0) {
      const err = new Error('Unexpected packet during handshake phase');
      if (this.onResult) {
        this.onResult(err);
      } else {
        connection.emit('error', err);
      }
      return null;
    }
    // this should be called from ClientHandshake command only
    // and skipped when called from ChangeUser command
    if (!connection.authorized) {
      connection.authorized = true;
      if (connection.config.compress) {
        const enableCompression = require('../compressed_protocol.js')
          .enableCompression;
        enableCompression(connection);
      }
    }
    if (this.onResult) {
      this.onResult(null);
    }
    return null;
  }
}
module.exports = ClientHandshake;

}, function(modId) { var map = {"./command.js":1619928528808,"../packets/index.js":1619928528778,"../constants/client.js":1619928528787,"../constants/charset_encodings.js":1619928528789,"../auth_41.js":1619928528788,"./auth_switch":1619928528809,"../compressed_protocol.js":1619928528813}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528808, function(require, module, exports) {


const EventEmitter = require('events').EventEmitter;

class Command extends EventEmitter {
  constructor() {
    super();
    this.next = null;
  }

  // slow. debug only
  stateName() {
    const state = this.next;
    for (const i in this) {
      if (this[i] === state && i !== 'next') {
        return i;
      }
    }
    return 'unknown name';
  }

  execute(packet, connection) {
    if (!this.next) {
      this.next = this.start;
      connection._resetSequenceId();
    }
    if (packet && packet.isError()) {
      const err = packet.asError(connection.clientEncoding);
      if (this.onResult) {
        this.onResult(err);
        this.emit('end');
      } else {
        this.emit('error', err);
        this.emit('end');
      }
      return true;
    }
    // TODO: don't return anything from execute, it's ugly and error-prone. Listen for 'end' event in connection
    this.next = this.next(packet, connection);
    if (this.next) {
      return false;
    } 
    this.emit('end');
    return true;
    
  }
}

module.exports = Command;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528809, function(require, module, exports) {


const Packets = require('../packets/index.js');
const sha256_password = require('../auth_plugins/sha256_password');
const caching_sha2_password = require('../auth_plugins/caching_sha2_password.js');
const mysql_native_password = require('../auth_plugins/mysql_native_password.js');

const standardAuthPlugins = {
  sha256_password: sha256_password({}),
  caching_sha2_password: caching_sha2_password({}),
  mysql_native_password: mysql_native_password({})
};

function warnLegacyAuthSwitch() {
  console.warn(
    'WARNING! authSwitchHandler api is deprecated, please use new authPlugins api'
  );
}

function authSwitchRequest(packet, connection, command) {
  const { pluginName, pluginData } = Packets.AuthSwitchRequest.fromPacket(
    packet
  );
  let authPlugin =
    connection.config.authPlugins && connection.config.authPlugins[pluginName];

  // legacy plugin api don't allow to override mysql_native_password
  // if pluginName is mysql_native_password it's using standard auth4.1 auth
  if (
    connection.config.authSwitchHandler &&
    pluginName !== 'mysql_native_password'
  ) {
    const legacySwitchHandler = connection.config.authSwitchHandler;
    warnLegacyAuthSwitch();
    legacySwitchHandler({ pluginName, pluginData }, (err, data) => {
      if (err) {
        connection.emit('error', err);
        return;
      }
      connection.writePacket(new Packets.AuthSwitchResponse(data).toPacket());
    });
    return;
  }
  if (!authPlugin) {
    authPlugin = standardAuthPlugins[pluginName];
  }
  if (!authPlugin) {
    throw new Error(
      `Server requests authentication using unknown plugin ${pluginName}. See ${'TODO: add plugins doco here'} on how to configure or author authentication plugins.`
    );
  }
  connection._authPlugin = authPlugin({ connection, command });
  Promise.resolve(connection._authPlugin(pluginData)).then(data => {
    if (data) {
      connection.writePacket(new Packets.AuthSwitchResponse(data).toPacket());
    }
  });
}

function authSwitchRequestMoreData(packet, connection) {
  const { data } = Packets.AuthSwitchRequestMoreData.fromPacket(packet);

  if (connection.config.authSwitchHandler) {
    const legacySwitchHandler = connection.config.authSwitchHandler;
    warnLegacyAuthSwitch();
    legacySwitchHandler({ pluginData: data }, (err, data) => {
      if (err) {
        connection.emit('error', err);
        return;
      }
      connection.writePacket(new Packets.AuthSwitchResponse(data).toPacket());
    });
    return;
  }

  if (!connection._authPlugin) {
    throw new Error(
      'AuthPluginMoreData received but no auth plugin instance found'
    );
  }
  Promise.resolve(connection._authPlugin(data)).then(data => {
    if (data) {
      connection.writePacket(new Packets.AuthSwitchResponse(data).toPacket());
    }
  });
}

module.exports = {
  authSwitchRequest,
  authSwitchRequestMoreData
};

}, function(modId) { var map = {"../packets/index.js":1619928528778,"../auth_plugins/sha256_password":1619928528810,"../auth_plugins/caching_sha2_password.js":1619928528811,"../auth_plugins/mysql_native_password.js":1619928528812}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528810, function(require, module, exports) {


const PLUGIN_NAME = 'sha256_password';
const crypto = require('crypto');
const { xor } = require('../auth_41');

const REQUEST_SERVER_KEY_PACKET = Buffer.from([1]);

const STATE_INITIAL = 0;
const STATE_WAIT_SERVER_KEY = 1;
const STATE_FINAL = -1;

function encrypt(password, scramble, key) {
  const stage1 = xor(
    Buffer.from(`${password}\0`, 'utf8').toString('binary'),
    scramble.toString('binary')
  );
  return crypto.publicEncrypt(key, stage1);
}

module.exports = (pluginOptions = {}) => ({ connection }) => {
  let state = 0;
  let scramble = null;

  const password = connection.config.password;

  const authWithKey = serverKey => {
    const _password = encrypt(password, scramble, serverKey);
    state = STATE_FINAL;
    return _password;
  };

  return data => {
    switch (state) {
      case STATE_INITIAL:
        scramble = data.slice(0, 20);
        // if client provides key we can save one extra roundrip on first connection
        if (pluginOptions.serverPublicKey) {
          return authWithKey(pluginOptions.serverPublicKey);
        }

        state = STATE_WAIT_SERVER_KEY;
        return REQUEST_SERVER_KEY_PACKET;

      case STATE_WAIT_SERVER_KEY:
        if (pluginOptions.onServerPublicKey) {
          pluginOptions.onServerPublicKey(data);
        }
        return authWithKey(data);
      case STATE_FINAL:
        throw new Error(
          `Unexpected data in AuthMoreData packet received by ${PLUGIN_NAME} plugin in STATE_FINAL state.`
        );
    }

    throw new Error(
      `Unexpected data in AuthMoreData packet received by ${PLUGIN_NAME} plugin in state ${state}`
    );
  };
};

}, function(modId) { var map = {"../auth_41":1619928528788}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528811, function(require, module, exports) {


// https://mysqlserverteam.com/mysql-8-0-4-new-default-authentication-plugin-caching_sha2_password/

const PLUGIN_NAME = 'caching_sha2_password';
const crypto = require('crypto');
const { xor, xorRotating } = require('../auth_41');

const REQUEST_SERVER_KEY_PACKET = Buffer.from([2]);
const FAST_AUTH_SUCCESS_PACKET = Buffer.from([3]);
const PERFORM_FULL_AUTHENTICATION_PACKET = Buffer.from([4]);

const STATE_INITIAL = 0;
const STATE_TOKEN_SENT = 1;
const STATE_WAIT_SERVER_KEY = 2;
const STATE_FINAL = -1;

function sha256(msg) {
  const hash = crypto.createHash('sha256');
  hash.update(msg, 'binary');
  return hash.digest('binary');
}

function calculateToken(password, scramble) {
  if (!password) {
    return Buffer.alloc(0);
  }
  const stage1 = sha256(Buffer.from(password, 'utf8').toString('binary'));
  const stage2 = sha256(stage1);
  const stage3 = sha256(stage2 + scramble.toString('binary'));
  return xor(stage1, stage3);
}

function encrypt(password, scramble, key) {
  const stage1 = xorRotating(
    Buffer.from(`${password}\0`, 'utf8').toString('binary'),
    scramble.toString('binary')
  );
  return crypto.publicEncrypt(key, stage1);
}

module.exports = (pluginOptions = {}) => ({ connection }) => {
  let state = 0;
  let scramble = null;

  const password = connection.config.password;

  const authWithKey = serverKey => {
    const _password = encrypt(password, scramble, serverKey);
    state = STATE_FINAL;
    return _password;
  };

  return data => {
    switch (state) {
      case STATE_INITIAL:
        scramble = data.slice(0, 20);
        state = STATE_TOKEN_SENT;
        return calculateToken(password, scramble);

      case STATE_TOKEN_SENT:
        if (FAST_AUTH_SUCCESS_PACKET.equals(data)) {
          state = STATE_FINAL;
          return null;
        }

        if (PERFORM_FULL_AUTHENTICATION_PACKET.equals(data)) {
          const isSecureConnection =
            typeof pluginOptions.overrideIsSecure === 'undefined'
              ? connection.config.ssl || connection.config.socketPath
              : pluginOptions.overrideIsSecure;
          if (isSecureConnection) {
            state = STATE_FINAL;
            return Buffer.from(`${password}\0`, 'utf8');
          }

          // if client provides key we can save one extra roundrip on first connection
          if (pluginOptions.serverPublicKey) {
            return authWithKey(pluginOptions.serverPublicKey);
          }

          state = STATE_WAIT_SERVER_KEY;
          return REQUEST_SERVER_KEY_PACKET;
        }
        throw new Error(
          `Invalid AuthMoreData packet received by ${PLUGIN_NAME} plugin in STATE_TOKEN_SENT state.`
        );
      case STATE_WAIT_SERVER_KEY:
        if (pluginOptions.onServerPublicKey) {
          pluginOptions.onServerPublicKey(data);
        }
        return authWithKey(data);
      case STATE_FINAL:
        throw new Error(
          `Unexpected data in AuthMoreData packet received by ${PLUGIN_NAME} plugin in STATE_FINAL state.`
        );
    }

    throw new Error(
      `Unexpected data in AuthMoreData packet received by ${PLUGIN_NAME} plugin in state ${state}`
    );
  };
};

}, function(modId) { var map = {"../auth_41":1619928528788}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528812, function(require, module, exports) {


//const PLUGIN_NAME = 'mysql_native_password';
const auth41 = require('../auth_41.js');

module.exports = pluginOptions => ({ connection, command }) => {
  const password =
    command.password || pluginOptions.password || connection.config.password;
  const passwordSha1 =
    command.passwordSha1 ||
    pluginOptions.passwordSha1 ||
    connection.config.passwordSha1;
  return data => {
    const authPluginData1 = data.slice(0, 8);
    const authPluginData2 = data.slice(8, 20);
    let authToken;
    if (passwordSha1) {
      authToken = auth41.calculateTokenFromPasswordSha(
        passwordSha1,
        authPluginData1,
        authPluginData2
      );
    } else {
      authToken = auth41.calculateToken(
        password,
        authPluginData1,
        authPluginData2
      );
    }
    return authToken;
  };
};

}, function(modId) { var map = {"../auth_41.js":1619928528788}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528813, function(require, module, exports) {


// connection mixins
// implementation of http://dev.mysql.com/doc/internals/en/compression.html

const zlib = require('zlib');
const PacketParser = require('./packet_parser.js');

function handleCompressedPacket(packet) {
  // eslint-disable-next-line consistent-this, no-invalid-this
  const connection = this;
  const deflatedLength = packet.readInt24();
  const body = packet.readBuffer();

  if (deflatedLength !== 0) {
    connection.inflateQueue.push(task => {
      zlib.inflate(body, (err, data) => {
        if (err) {
          connection._handleNetworkError(err);
          return;
        }
        connection._bumpCompressedSequenceId(packet.numPackets);
        connection._inflatedPacketsParser.execute(data);
        task.done();
      });
    });
  } else {
    connection.inflateQueue.push(task => {
      connection._bumpCompressedSequenceId(packet.numPackets);
      connection._inflatedPacketsParser.execute(body);
      task.done();
    });
  }
}

function writeCompressed(buffer) {
  // http://dev.mysql.com/doc/internals/en/example-several-mysql-packets.html
  // note: sending a MySQL Packet of the size 2^24−5 to 2^24−1 via compression
  // leads to at least one extra compressed packet.
  // (this is because "length of the packet before compression" need to fit
  // into 3 byte unsigned int. "length of the packet before compression" includes
  // 4 byte packet header, hence 2^24−5)
  const MAX_COMPRESSED_LENGTH = 16777210;
  let start;
  if (buffer.length > MAX_COMPRESSED_LENGTH) {
    for (start = 0; start < buffer.length; start += MAX_COMPRESSED_LENGTH) {
      writeCompressed.call(
        // eslint-disable-next-line no-invalid-this
        this,
        buffer.slice(start, start + MAX_COMPRESSED_LENGTH)
      );
    }
    return;
  }

  // eslint-disable-next-line no-invalid-this, consistent-this
  const connection = this;

  let packetLen = buffer.length;
  const compressHeader = Buffer.allocUnsafe(7);

  // seqqueue is used here because zlib async execution is routed via thread pool
  // internally and when we have multiple compressed packets arriving we need
  // to assemble uncompressed result sequentially
  (function(seqId) {
    connection.deflateQueue.push(task => {
      zlib.deflate(buffer, (err, compressed) => {
        if (err) {
          connection._handleFatalError(err);
          return;
        }
        let compressedLength = compressed.length;

        if (compressedLength < packetLen) {
          compressHeader.writeUInt8(compressedLength & 0xff, 0);
          compressHeader.writeUInt16LE(compressedLength >> 8, 1);
          compressHeader.writeUInt8(seqId, 3);
          compressHeader.writeUInt8(packetLen & 0xff, 4);
          compressHeader.writeUInt16LE(packetLen >> 8, 5);
          connection.writeUncompressed(compressHeader);
          connection.writeUncompressed(compressed);
        } else {
          // http://dev.mysql.com/doc/internals/en/uncompressed-payload.html
          // To send an uncompressed payload:
          //   - set length of payload before compression to 0
          //   - the compressed payload contains the uncompressed payload instead.
          compressedLength = packetLen;
          packetLen = 0;
          compressHeader.writeUInt8(compressedLength & 0xff, 0);
          compressHeader.writeUInt16LE(compressedLength >> 8, 1);
          compressHeader.writeUInt8(seqId, 3);
          compressHeader.writeUInt8(packetLen & 0xff, 4);
          compressHeader.writeUInt16LE(packetLen >> 8, 5);
          connection.writeUncompressed(compressHeader);
          connection.writeUncompressed(buffer);
        }
        task.done();
      });
    });
  })(connection.compressedSequenceId);
  connection._bumpCompressedSequenceId(1);
}

function enableCompression(connection) {
  connection._lastWrittenPacketId = 0;
  connection._lastReceivedPacketId = 0;

  connection._handleCompressedPacket = handleCompressedPacket;
  connection._inflatedPacketsParser = new PacketParser(p => {
    connection.handlePacket(p);
  }, 4);
  connection._inflatedPacketsParser._lastPacket = 0;
  connection.packetParser = new PacketParser(packet => {
    connection._handleCompressedPacket(packet);
  }, 7);

  connection.writeUncompressed = connection.write;
  connection.write = writeCompressed;

  const seqqueue = require('seq-queue');
  connection.inflateQueue = seqqueue.createQueue();
  connection.deflateQueue = seqqueue.createQueue();
}

module.exports = {
  enableCompression: enableCompression
};

}, function(modId) { var map = {"./packet_parser.js":1619928528774}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528814, function(require, module, exports) {


const CommandCode = require('../constants/commands.js');
const Errors = require('../constants/errors.js');

const Command = require('./command.js');
const Packets = require('../packets/index.js');

class ServerHandshake extends Command {
  constructor(args) {
    super();
    this.args = args;
    /*
    this.protocolVersion = args.protocolVersion || 10;
    this.serverVersion   = args.serverVersion;
    this.connectionId    = args.connectionId,
    this.statusFlags     = args.statusFlags,
    this.characterSet    = args.characterSet,
    this.capabilityFlags = args.capabilityFlags || 512;
    */
  }

  start(packet, connection) {
    const serverHelloPacket = new Packets.Handshake(this.args);
    this.serverHello = serverHelloPacket;
    serverHelloPacket.setScrambleData(err => {
      if (err) {
        connection.emit('error', new Error('Error generating random bytes'));
        return;
      }
      connection.writePacket(serverHelloPacket.toPacket(0));
    });
    return ServerHandshake.prototype.readClientReply;
  }

  readClientReply(packet, connection) {
    // check auth here
    const clientHelloReply = Packets.HandshakeResponse.fromPacket(packet);
    // TODO check we don't have something similar already
    connection.clientHelloReply = clientHelloReply;
    if (this.args.authCallback) {
      this.args.authCallback(
        {
          user: clientHelloReply.user,
          database: clientHelloReply.database,
          address: connection.stream.remoteAddress,
          authPluginData1: this.serverHello.authPluginData1,
          authPluginData2: this.serverHello.authPluginData2,
          authToken: clientHelloReply.authToken
        },
        (err, mysqlError) => {
          // if (err)
          if (!mysqlError) {
            connection.writeOk();
          } else {
            // TODO create constants / errorToCode
            // 1045 = ER_ACCESS_DENIED_ERROR
            connection.writeError({
              message: mysqlError.message || '',
              code: mysqlError.code || 1045
            });
            connection.close();
          }
        }
      );
    } else {
      connection.writeOk();
    }
    return ServerHandshake.prototype.dispatchCommands;
  }

  dispatchCommands(packet, connection) {
    // command from client to server
    let knownCommand = true;
    const encoding = connection.clientHelloReply.encoding;
    const commandCode = packet.readInt8();
    switch (commandCode) {
      case CommandCode.QUIT:
        if (connection.listeners('quit').length) {
          connection.emit('quit');
        } else {
          connection.stream.end();
        }
        break;
      case CommandCode.INIT_DB:
        if (connection.listeners('init_db').length) {
          const schemaName = packet.readString(undefined, encoding);
          connection.emit('init_db', schemaName);
        } else {
          connection.writeOk();
        }
        break;
      case CommandCode.QUERY:
        if (connection.listeners('query').length) {
          const query = packet.readString(undefined, encoding);
          connection.emit('query', query);
        } else {
          connection.writeError({
            code: Errors.HA_ERR_INTERNAL_ERROR,
            message: 'No query handler'
          });
        }
        break;
      case CommandCode.FIELD_LIST:
        if (connection.listeners('field_list').length) {
          const table = packet.readNullTerminatedString();
          const fields = packet.readString(undefined, encoding);
          connection.emit('field_list', table, fields);
        } else {
          connection.writeError({
            code: Errors.ER_WARN_DEPRECATED_SYNTAX,
            message:
              'As of MySQL 5.7.11, COM_FIELD_LIST is deprecated and will be removed in a future version of MySQL.'
          });
        }
        break;
      case CommandCode.PING:
        if (connection.listeners('ping').length) {
          connection.emit('ping');
        } else {
          connection.writeOk();
        }
        break;
      default:
        knownCommand = false;
    }
    if (connection.listeners('packet').length) {
      connection.emit('packet', packet.clone(), knownCommand, commandCode);
    } else if (!knownCommand) {
      // eslint-disable-next-line no-console
      console.log('Unknown command:', commandCode);
    }
    return ServerHandshake.prototype.dispatchCommands;
  }
}

module.exports = ServerHandshake;

// TODO: implement server-side 4.1 authentication
/*
4.1 authentication: (http://bazaar.launchpad.net/~mysql/mysql-server/5.5/view/head:/sql/password.c)

  SERVER:  public_seed=create_random_string()
           send(public_seed)

  CLIENT:  recv(public_seed)
           hash_stage1=sha1("password")
           hash_stage2=sha1(hash_stage1)
           reply=xor(hash_stage1, sha1(public_seed,hash_stage2)

           // this three steps are done in scramble()

           send(reply)


  SERVER:  recv(reply)
           hash_stage1=xor(reply, sha1(public_seed,hash_stage2))
           candidate_hash2=sha1(hash_stage1)
           check(candidate_hash2==hash_stage2)

server stores sha1(sha1(password)) ( hash_stag2)
*/

}, function(modId) { var map = {"../constants/commands.js":1619928528785,"../constants/errors.js":1619928528776,"./command.js":1619928528808,"../packets/index.js":1619928528778}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528815, function(require, module, exports) {


const process = require('process');

const Readable = require('stream').Readable;

const Command = require('./command.js');
const Packets = require('../packets/index.js');
const getTextParser = require('../parsers/text_parser.js');
const ServerStatus = require('../constants/server_status.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');

const EmptyPacket = new Packets.Packet(0, Buffer.allocUnsafe(4), 0, 4);

// http://dev.mysql.com/doc/internals/en/com-query.html
class Query extends Command {
  constructor(options, callback) {
    super();
    this.sql = options.sql;
    this.values = options.values;
    this._queryOptions = options;
    this.namedPlaceholders = options.namedPlaceholders || false;
    this.onResult = callback;
    this._fieldCount = 0;
    this._rowParser = null;
    this._fields = [];
    this._rows = [];
    this._receivedFieldsCount = 0;
    this._resultIndex = 0;
    this._localStream = null;
    this._unpipeStream = function() {};
    this._streamFactory = options.infileStreamFactory;
    this._connection = null;
  }

  then() {
    const err =
      "You have tried to call .then(), .catch(), or invoked await on the result of query that is not a promise, which is a programming error. Try calling con.promise().query(), or require('mysql2/promise') instead of 'mysql2' for a promise-compatible version of the query interface. To learn how to use async/await or Promises check out documentation at https://www.npmjs.com/package/mysql2#using-promise-wrapper, or the mysql2 documentation at https://github.com/sidorares/node-mysql2/tree/master/documentation/Promise-Wrapper.md";
    // eslint-disable-next-line
    console.log(err);
    throw new Error(err);
  }

  start(packet, connection) {
    if (connection.config.debug) {
      // eslint-disable-next-line
      console.log('        Sending query command: %s', this.sql);
    }
    this._connection = connection;
    this.options = Object.assign({}, connection.config, this._queryOptions);
    const cmdPacket = new Packets.Query(
      this.sql,
      connection.config.charsetNumber
    );
    connection.writePacket(cmdPacket.toPacket(1));
    return Query.prototype.resultsetHeader;
  }

  done() {
    this._unpipeStream();
    if (this.onResult) {
      let rows, fields;
      if (this._resultIndex === 0) {
        rows = this._rows[0];
        fields = this._fields[0];
      } else {
        rows = this._rows;
        fields = this._fields;
      }
      if (fields) {
        process.nextTick(() => {
          this.onResult(null, rows, fields);
        });
      } else {
        process.nextTick(() => {
          this.onResult(null, rows);
        });
      }
    }
    return null;
  }

  doneInsert(rs) {
    if (this._localStreamError) {
      if (this.onResult) {
        this.onResult(this._localStreamError, rs);
      } else {
        this.emit('error', this._localStreamError);
      }
      return null;
    }
    this._rows.push(rs);
    this._fields.push(void 0);
    this.emit('fields', void 0);
    this.emit('result', rs);
    if (rs.serverStatus & ServerStatus.SERVER_MORE_RESULTS_EXISTS) {
      this._resultIndex++;
      return this.resultsetHeader;
    }
    return this.done();
  }

  resultsetHeader(packet, connection) {
    const rs = new Packets.ResultSetHeader(packet, connection);
    this._fieldCount = rs.fieldCount;
    if (connection.config.debug) {
      // eslint-disable-next-line
      console.log(
        `        Resultset header received, expecting ${rs.fieldCount} column definition packets`
      );
    }
    if (this._fieldCount === 0) {
      return this.doneInsert(rs);
    }
    if (this._fieldCount === null) {
      return this._streamLocalInfile(connection, rs.infileName);
    }
    this._receivedFieldsCount = 0;
    this._rows.push([]);
    this._fields.push([]);
    return this.readField;
  }

  _streamLocalInfile(connection, path) {
    if (this._streamFactory) {
      this._localStream = this._streamFactory(path);
    } else {
      this._localStreamError = new Error(
        `As a result of LOCAL INFILE command server wants to read ${path} file, but as of v2.0 you must provide streamFactory option returning ReadStream.`
      );
      connection.writePacket(EmptyPacket);
      return this.infileOk;
    }

    const onConnectionError = () => {
      this._unpipeStream();
    };
    const onDrain = () => {
      this._localStream.resume();
    };
    const onPause = () => {
      this._localStream.pause();
    };
    const onData = function(data) {
      const dataWithHeader = Buffer.allocUnsafe(data.length + 4);
      data.copy(dataWithHeader, 4);
      connection.writePacket(
        new Packets.Packet(0, dataWithHeader, 0, dataWithHeader.length)
      );
    };
    const onEnd = () => {
      connection.removeListener('error', onConnectionError);
      connection.writePacket(EmptyPacket);
    };
    const onError = err => {
      this._localStreamError = err;
      connection.removeListener('error', onConnectionError);
      connection.writePacket(EmptyPacket);
    };
    this._unpipeStream = () => {
      connection.stream.removeListener('pause', onPause);
      connection.stream.removeListener('drain', onDrain);
      this._localStream.removeListener('data', onData);
      this._localStream.removeListener('end', onEnd);
      this._localStream.removeListener('error', onError);
    };
    connection.stream.on('pause', onPause);
    connection.stream.on('drain', onDrain);
    this._localStream.on('data', onData);
    this._localStream.on('end', onEnd);
    this._localStream.on('error', onError);
    connection.once('error', onConnectionError);
    return this.infileOk;
  }

  readField(packet, connection) {
    this._receivedFieldsCount++;
    // Often there is much more data in the column definition than in the row itself
    // If you set manually _fields[0] to array of ColumnDefinition's (from previous call)
    // you can 'cache' result of parsing. Field packets still received, but ignored in that case
    // this is the reason _receivedFieldsCount exist (otherwise we could just use current length of fields array)
    if (this._fields[this._resultIndex].length !== this._fieldCount) {
      const field = new Packets.ColumnDefinition(
        packet,
        connection.clientEncoding
      );
      this._fields[this._resultIndex].push(field);
      if (connection.config.debug) {
        /* eslint-disable no-console */
        console.log('        Column definition:');
        console.log(`          name: ${field.name}`);
        console.log(`          type: ${field.columnType}`);
        console.log(`         flags: ${field.flags}`);
        /* eslint-enable no-console */
      }
    }
    // last field received
    if (this._receivedFieldsCount === this._fieldCount) {
      const fields = this._fields[this._resultIndex];
      this.emit('fields', fields);
      this._rowParser = getTextParser(fields, this.options, connection.config);
      return Query.prototype.fieldsEOF;
    }
    return Query.prototype.readField;
  }

  fieldsEOF(packet, connection) {
    // check EOF
    if (!packet.isEOF()) {
      return connection.protocolError('Expected EOF packet');
    }
    return this.row;
  }

  row(packet) {
    if (packet.isEOF()) {
      const status = packet.eofStatusFlags();
      const moreResults = status & ServerStatus.SERVER_MORE_RESULTS_EXISTS;
      if (moreResults) {
        this._resultIndex++;
        return Query.prototype.resultsetHeader;
      }
      return this.done();
    }
    let row;
    try {
      row = new this._rowParser(
        packet,
        this._fields[this._resultIndex],
        this.options,
        CharsetToEncoding
      );
    } catch (err) {
      this._localStreamError = err;
      return this.doneInsert(null);
    }
    if (this.onResult) {
      this._rows[this._resultIndex].push(row);
    } else {
      this.emit('result', row);
    }
    return Query.prototype.row;
  }

  infileOk(packet, connection) {
    const rs = new Packets.ResultSetHeader(packet, connection);
    return this.doneInsert(rs);
  }

  stream(options) {
    options = options || {};
    options.objectMode = true;
    const stream = new Readable(options);
    stream._read = () => {
      this._connection && this._connection.resume();
    };
    this.on('result', row => {
      if (!stream.push(row)) {
        this._connection.pause();
      }
      stream.emit('result', row); // replicate old emitter
    });
    this.on('error', err => {
      stream.emit('error', err); // Pass on any errors
    });
    this.on('end', () => {
      stream.push(null); // pushing null, indicating EOF
      stream.emit('close'); // notify readers that query has completed
    });
    this.on('fields', fields => {
      stream.emit('fields', fields); // replicate old emitter
    });
    return stream;
  }
}

Query.prototype.catch = Query.prototype.then;

module.exports = Query;

}, function(modId) { var map = {"./command.js":1619928528808,"../packets/index.js":1619928528778,"../parsers/text_parser.js":1619928528816,"../constants/server_status.js":1619928528801,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528816, function(require, module, exports) {


const Types = require('../constants/types.js');
const Charsets = require('../constants/charsets.js');
const helpers = require('../helpers');
const genFunc = require('generate-function');
const parserCache = require('./parser_cache.js');

const typeNames = [];
for (const t in Types) {
  typeNames[Types[t]] = t;
}

function readCodeFor(type, charset, encodingExpr, config, options) {
  const supportBigNumbers =
    options.supportBigNumbers || config.supportBigNumbers;
  const bigNumberStrings = options.bigNumberStrings || config.bigNumberStrings;
  const timezone = options.timezone || config.timezone;
  const dateStrings = options.dateStrings || config.dateStrings;

  switch (type) {
    case Types.TINY:
    case Types.SHORT:
    case Types.LONG:
    case Types.INT24:
    case Types.YEAR:
      return 'packet.parseLengthCodedIntNoBigCheck()';
    case Types.LONGLONG:
      if (supportBigNumbers && bigNumberStrings) {
        return 'packet.parseLengthCodedIntString()';
      }
      return `packet.parseLengthCodedInt(${supportBigNumbers})`;
    case Types.FLOAT:
    case Types.DOUBLE:
      return 'packet.parseLengthCodedFloat()';
    case Types.NULL:
      return 'packet.readLengthCodedNumber()';
    case Types.DECIMAL:
    case Types.NEWDECIMAL:
      if (config.decimalNumbers) {
        return 'packet.parseLengthCodedFloat()';
      }
      return 'packet.readLengthCodedString("ascii")';
    case Types.DATE:
      if (helpers.typeMatch(type, dateStrings, Types)) {
        return 'packet.readLengthCodedString("ascii")';
      }
      return `packet.parseDate('${timezone}')`;
    case Types.DATETIME:
    case Types.TIMESTAMP:
      if (helpers.typeMatch(type, dateStrings, Types)) {
        return 'packet.readLengthCodedString("ascii")';
      }
      return `packet.parseDateTime('${timezone}')`;
    case Types.TIME:
      return 'packet.readLengthCodedString("ascii")';
    case Types.GEOMETRY:
      return 'packet.parseGeometryValue()';
    case Types.JSON:
      // Since for JSON columns mysql always returns charset 63 (BINARY),
      // we have to handle it according to JSON specs and use "utf8",
      // see https://github.com/sidorares/node-mysql2/issues/409
      return 'JSON.parse(packet.readLengthCodedString("utf8"))';
    default:
      if (charset === Charsets.BINARY) {
        return 'packet.readLengthCodedBuffer()';
      }
      return `packet.readLengthCodedString(${encodingExpr})`;
  }
}

function compile(fields, options, config) {
  // node-mysql typeCast compatibility wrapper
  // see https://github.com/mysqljs/mysql/blob/96fdd0566b654436624e2375c7b6604b1f50f825/lib/protocol/packets/Field.js
  function wrap(field, type, packet, encoding) {
    return {
      type: type,
      length: field.columnLength,
      db: field.schema,
      table: field.table,
      name: field.name,
      string: function() {
        return packet.readLengthCodedString(encoding);
      },
      buffer: function() {
        return packet.readLengthCodedBuffer();
      },
      geometry: function() {
        return packet.parseGeometryValue();
      }
    };
  }

  // use global typeCast if current query doesn't specify one
  if (
    typeof config.typeCast === 'function' &&
    typeof options.typeCast !== 'function'
  ) {
    options.typeCast = config.typeCast;
  }

  const parserFn = genFunc();
  let i = 0;

  /* eslint-disable no-trailing-spaces */
  /* eslint-disable no-spaced-func */
  /* eslint-disable no-unexpected-multiline */
  parserFn('(function () {')(
    'return function TextRow(packet, fields, options, CharsetToEncoding) {'
  );

  if (options.rowsAsArray) {
    parserFn(`const result = new Array(${fields.length})`);
  }

  if (typeof options.typeCast === 'function') {
    parserFn(`const wrap = ${wrap.toString()}`);
  }

  const resultTables = {};
  let resultTablesArray = [];

  if (options.nestTables === true) {
    for (i = 0; i < fields.length; i++) {
      resultTables[fields[i].table] = 1;
    }
    resultTablesArray = Object.keys(resultTables);
    for (i = 0; i < resultTablesArray.length; i++) {
      parserFn(`this[${helpers.srcEscape(resultTablesArray[i])}] = {};`);
    }
  }

  let lvalue = '';
  let fieldName = '';
  for (i = 0; i < fields.length; i++) {
    fieldName = helpers.srcEscape(fields[i].name);
    parserFn(`// ${fieldName}: ${typeNames[fields[i].columnType]}`);
    if (typeof options.nestTables === 'string') {
      lvalue = `this[${helpers.srcEscape(
        fields[i].table + options.nestTables + fields[i].name
      )}]`;
    } else if (options.nestTables === true) {
      lvalue = `this[${helpers.srcEscape(fields[i].table)}][${fieldName}]`;
    } else if (options.rowsAsArray) {
      lvalue = `result[${i.toString(10)}]`;
    } else {
      lvalue = `this[${fieldName}]`;
    }
    const encodingExpr = `CharsetToEncoding[fields[${i}].characterSet]`;
    const readCode = readCodeFor(
      fields[i].columnType,
      fields[i].characterSet,
      encodingExpr,
      config,
      options
    );
    if (typeof options.typeCast === 'function') {
      parserFn(
        `${lvalue} = options.typeCast(wrap(fields[${i}], ${helpers.srcEscape(
          typeNames[fields[i].columnType]
        )}, packet, ${encodingExpr}), function() { return ${readCode};})`
      );
    } else if (options.typeCast === false) {
      parserFn(`${lvalue} = packet.readLengthCodedBuffer();`);
    } else {
      parserFn(`${lvalue} = ${readCode};`);
    }
  }

  if (options.rowsAsArray) {
    parserFn('return result;');
  }

  parserFn('};')('})()');

  /* eslint-enable no-trailing-spaces */
  /* eslint-enable no-spaced-func */
  /* eslint-enable no-unexpected-multiline */

  if (config.debug) {
    helpers.printDebugWithCode(
      'Compiled text protocol row parser',
      parserFn.toString()
    );
  }
  return parserFn.toFunction();
}

function getTextParser(fields, options, config) {
  return parserCache.getParser('text', fields, options, config, compile);
}

module.exports = getTextParser;

}, function(modId) { var map = {"../constants/types.js":1619928528783,"../constants/charsets.js":1619928528817,"../helpers":1619928528818,"./parser_cache.js":1619928528819}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528817, function(require, module, exports) {


exports.BIG5_CHINESE_CI = 1;
exports.LATIN2_CZECH_CS = 2;
exports.DEC8_SWEDISH_CI = 3;
exports.CP850_GENERAL_CI = 4;
exports.LATIN1_GERMAN1_CI = 5;
exports.HP8_ENGLISH_CI = 6;
exports.KOI8R_GENERAL_CI = 7;
exports.LATIN1_SWEDISH_CI = 8;
exports.LATIN2_GENERAL_CI = 9;
exports.SWE7_SWEDISH_CI = 10;
exports.ASCII_GENERAL_CI = 11;
exports.UJIS_JAPANESE_CI = 12;
exports.SJIS_JAPANESE_CI = 13;
exports.CP1251_BULGARIAN_CI = 14;
exports.LATIN1_DANISH_CI = 15;
exports.HEBREW_GENERAL_CI = 16;
exports.TIS620_THAI_CI = 18;
exports.EUCKR_KOREAN_CI = 19;
exports.LATIN7_ESTONIAN_CS = 20;
exports.LATIN2_HUNGARIAN_CI = 21;
exports.KOI8U_GENERAL_CI = 22;
exports.CP1251_UKRAINIAN_CI = 23;
exports.GB2312_CHINESE_CI = 24;
exports.GREEK_GENERAL_CI = 25;
exports.CP1250_GENERAL_CI = 26;
exports.LATIN2_CROATIAN_CI = 27;
exports.GBK_CHINESE_CI = 28;
exports.CP1257_LITHUANIAN_CI = 29;
exports.LATIN5_TURKISH_CI = 30;
exports.LATIN1_GERMAN2_CI = 31;
exports.ARMSCII8_GENERAL_CI = 32;
exports.UTF8_GENERAL_CI = 33;
exports.CP1250_CZECH_CS = 34;
exports.UCS2_GENERAL_CI = 35;
exports.CP866_GENERAL_CI = 36;
exports.KEYBCS2_GENERAL_CI = 37;
exports.MACCE_GENERAL_CI = 38;
exports.MACROMAN_GENERAL_CI = 39;
exports.CP852_GENERAL_CI = 40;
exports.LATIN7_GENERAL_CI = 41;
exports.LATIN7_GENERAL_CS = 42;
exports.MACCE_BIN = 43;
exports.CP1250_CROATIAN_CI = 44;
exports.UTF8MB4_GENERAL_CI = 45;
exports.UTF8MB4_BIN = 46;
exports.LATIN1_BIN = 47;
exports.LATIN1_GENERAL_CI = 48;
exports.LATIN1_GENERAL_CS = 49;
exports.CP1251_BIN = 50;
exports.CP1251_GENERAL_CI = 51;
exports.CP1251_GENERAL_CS = 52;
exports.MACROMAN_BIN = 53;
exports.UTF16_GENERAL_CI = 54;
exports.UTF16_BIN = 55;
exports.UTF16LE_GENERAL_CI = 56;
exports.CP1256_GENERAL_CI = 57;
exports.CP1257_BIN = 58;
exports.CP1257_GENERAL_CI = 59;
exports.UTF32_GENERAL_CI = 60;
exports.UTF32_BIN = 61;
exports.UTF16LE_BIN = 62;
exports.BINARY = 63;
exports.ARMSCII8_BIN = 64;
exports.ASCII_BIN = 65;
exports.CP1250_BIN = 66;
exports.CP1256_BIN = 67;
exports.CP866_BIN = 68;
exports.DEC8_BIN = 69;
exports.GREEK_BIN = 70;
exports.HEBREW_BIN = 71;
exports.HP8_BIN = 72;
exports.KEYBCS2_BIN = 73;
exports.KOI8R_BIN = 74;
exports.KOI8U_BIN = 75;
exports.UTF8_TOLOWER_CI = 76;
exports.LATIN2_BIN = 77;
exports.LATIN5_BIN = 78;
exports.LATIN7_BIN = 79;
exports.CP850_BIN = 80;
exports.CP852_BIN = 81;
exports.SWE7_BIN = 82;
exports.UTF8_BIN = 83;
exports.BIG5_BIN = 84;
exports.EUCKR_BIN = 85;
exports.GB2312_BIN = 86;
exports.GBK_BIN = 87;
exports.SJIS_BIN = 88;
exports.TIS620_BIN = 89;
exports.UCS2_BIN = 90;
exports.UJIS_BIN = 91;
exports.GEOSTD8_GENERAL_CI = 92;
exports.GEOSTD8_BIN = 93;
exports.LATIN1_SPANISH_CI = 94;
exports.CP932_JAPANESE_CI = 95;
exports.CP932_BIN = 96;
exports.EUCJPMS_JAPANESE_CI = 97;
exports.EUCJPMS_BIN = 98;
exports.CP1250_POLISH_CI = 99;
exports.UTF16_UNICODE_CI = 101;
exports.UTF16_ICELANDIC_CI = 102;
exports.UTF16_LATVIAN_CI = 103;
exports.UTF16_ROMANIAN_CI = 104;
exports.UTF16_SLOVENIAN_CI = 105;
exports.UTF16_POLISH_CI = 106;
exports.UTF16_ESTONIAN_CI = 107;
exports.UTF16_SPANISH_CI = 108;
exports.UTF16_SWEDISH_CI = 109;
exports.UTF16_TURKISH_CI = 110;
exports.UTF16_CZECH_CI = 111;
exports.UTF16_DANISH_CI = 112;
exports.UTF16_LITHUANIAN_CI = 113;
exports.UTF16_SLOVAK_CI = 114;
exports.UTF16_SPANISH2_CI = 115;
exports.UTF16_ROMAN_CI = 116;
exports.UTF16_PERSIAN_CI = 117;
exports.UTF16_ESPERANTO_CI = 118;
exports.UTF16_HUNGARIAN_CI = 119;
exports.UTF16_SINHALA_CI = 120;
exports.UTF16_GERMAN2_CI = 121;
exports.UTF16_CROATIAN_CI = 122;
exports.UTF16_UNICODE_520_CI = 123;
exports.UTF16_VIETNAMESE_CI = 124;
exports.UCS2_UNICODE_CI = 128;
exports.UCS2_ICELANDIC_CI = 129;
exports.UCS2_LATVIAN_CI = 130;
exports.UCS2_ROMANIAN_CI = 131;
exports.UCS2_SLOVENIAN_CI = 132;
exports.UCS2_POLISH_CI = 133;
exports.UCS2_ESTONIAN_CI = 134;
exports.UCS2_SPANISH_CI = 135;
exports.UCS2_SWEDISH_CI = 136;
exports.UCS2_TURKISH_CI = 137;
exports.UCS2_CZECH_CI = 138;
exports.UCS2_DANISH_CI = 139;
exports.UCS2_LITHUANIAN_CI = 140;
exports.UCS2_SLOVAK_CI = 141;
exports.UCS2_SPANISH2_CI = 142;
exports.UCS2_ROMAN_CI = 143;
exports.UCS2_PERSIAN_CI = 144;
exports.UCS2_ESPERANTO_CI = 145;
exports.UCS2_HUNGARIAN_CI = 146;
exports.UCS2_SINHALA_CI = 147;
exports.UCS2_GERMAN2_CI = 148;
exports.UCS2_CROATIAN_CI = 149;
exports.UCS2_UNICODE_520_CI = 150;
exports.UCS2_VIETNAMESE_CI = 151;
exports.UCS2_GENERAL_MYSQL500_CI = 159;
exports.UTF32_UNICODE_CI = 160;
exports.UTF32_ICELANDIC_CI = 161;
exports.UTF32_LATVIAN_CI = 162;
exports.UTF32_ROMANIAN_CI = 163;
exports.UTF32_SLOVENIAN_CI = 164;
exports.UTF32_POLISH_CI = 165;
exports.UTF32_ESTONIAN_CI = 166;
exports.UTF32_SPANISH_CI = 167;
exports.UTF32_SWEDISH_CI = 168;
exports.UTF32_TURKISH_CI = 169;
exports.UTF32_CZECH_CI = 170;
exports.UTF32_DANISH_CI = 171;
exports.UTF32_LITHUANIAN_CI = 172;
exports.UTF32_SLOVAK_CI = 173;
exports.UTF32_SPANISH2_CI = 174;
exports.UTF32_ROMAN_CI = 175;
exports.UTF32_PERSIAN_CI = 176;
exports.UTF32_ESPERANTO_CI = 177;
exports.UTF32_HUNGARIAN_CI = 178;
exports.UTF32_SINHALA_CI = 179;
exports.UTF32_GERMAN2_CI = 180;
exports.UTF32_CROATIAN_CI = 181;
exports.UTF32_UNICODE_520_CI = 182;
exports.UTF32_VIETNAMESE_CI = 183;
exports.UTF8_UNICODE_CI = 192;
exports.UTF8_ICELANDIC_CI = 193;
exports.UTF8_LATVIAN_CI = 194;
exports.UTF8_ROMANIAN_CI = 195;
exports.UTF8_SLOVENIAN_CI = 196;
exports.UTF8_POLISH_CI = 197;
exports.UTF8_ESTONIAN_CI = 198;
exports.UTF8_SPANISH_CI = 199;
exports.UTF8_SWEDISH_CI = 200;
exports.UTF8_TURKISH_CI = 201;
exports.UTF8_CZECH_CI = 202;
exports.UTF8_DANISH_CI = 203;
exports.UTF8_LITHUANIAN_CI = 204;
exports.UTF8_SLOVAK_CI = 205;
exports.UTF8_SPANISH2_CI = 206;
exports.UTF8_ROMAN_CI = 207;
exports.UTF8_PERSIAN_CI = 208;
exports.UTF8_ESPERANTO_CI = 209;
exports.UTF8_HUNGARIAN_CI = 210;
exports.UTF8_SINHALA_CI = 211;
exports.UTF8_GERMAN2_CI = 212;
exports.UTF8_CROATIAN_CI = 213;
exports.UTF8_UNICODE_520_CI = 214;
exports.UTF8_VIETNAMESE_CI = 215;
exports.UTF8_GENERAL_MYSQL500_CI = 223;
exports.UTF8MB4_UNICODE_CI = 224;
exports.UTF8MB4_ICELANDIC_CI = 225;
exports.UTF8MB4_LATVIAN_CI = 226;
exports.UTF8MB4_ROMANIAN_CI = 227;
exports.UTF8MB4_SLOVENIAN_CI = 228;
exports.UTF8MB4_POLISH_CI = 229;
exports.UTF8MB4_ESTONIAN_CI = 230;
exports.UTF8MB4_SPANISH_CI = 231;
exports.UTF8MB4_SWEDISH_CI = 232;
exports.UTF8MB4_TURKISH_CI = 233;
exports.UTF8MB4_CZECH_CI = 234;
exports.UTF8MB4_DANISH_CI = 235;
exports.UTF8MB4_LITHUANIAN_CI = 236;
exports.UTF8MB4_SLOVAK_CI = 237;
exports.UTF8MB4_SPANISH2_CI = 238;
exports.UTF8MB4_ROMAN_CI = 239;
exports.UTF8MB4_PERSIAN_CI = 240;
exports.UTF8MB4_ESPERANTO_CI = 241;
exports.UTF8MB4_HUNGARIAN_CI = 242;
exports.UTF8MB4_SINHALA_CI = 243;
exports.UTF8MB4_GERMAN2_CI = 244;
exports.UTF8MB4_CROATIAN_CI = 245;
exports.UTF8MB4_UNICODE_520_CI = 246;
exports.UTF8MB4_VIETNAMESE_CI = 247;
exports.GB18030_CHINESE_CI = 248;
exports.GB18030_BIN = 249;
exports.GB18030_UNICODE_520_CI = 250;
exports.UTF8_GENERAL50_CI = 253;
exports.UTF8MB4_0900_AI_CI = 255;
exports.UTF8MB4_CS_0900_AI_CI = 266;
exports.UTF8MB4_DA_0900_AI_CI = 267;
exports.UTF8MB4_DE_PB_0900_AI_CI = 256;
exports.UTF8MB4_EO_0900_AI_CI = 273;
exports.UTF8MB4_ES_0900_AI_CI = 263;
exports.UTF8MB4_ES_TRAD_0900_AI_CI = 270;
exports.UTF8MB4_ET_0900_AI_CI = 262;
exports.UTF8MB4_HR_0900_AI_CI = 275;
exports.UTF8MB4_HU_0900_AI_CI = 274;
exports.UTF8MB4_IS_0900_AI_CI = 257;
exports.UTF8MB4_LA_0900_AI_CI = 271;
exports.UTF8MB4_LT_0900_AI_CI = 268;
exports.UTF8MB4_LV_0900_AI_CI = 258;
exports.UTF8MB4_PL_0900_AI_CI = 261;
exports.UTF8MB4_RO_0900_AI_CI = 259;
exports.UTF8MB4_SK_0900_AI_CI = 269;
exports.UTF8MB4_SL_0900_AI_CI = 260;
exports.UTF8MB4_SV_0900_AI_CI = 264;
exports.UTF8MB4_TR_0900_AI_CI = 265;
exports.UTF8MB4_VI_0900_AI_CI = 277;

// short aliases
exports.BIG5 = exports.BIG5_CHINESE_CI;
exports.DEC8 = exports.DEC8_SWEDISH_CI;
exports.CP850 = exports.CP850_GENERAL_CI;
exports.HP8 = exports.HP8_ENGLISH_CI;
exports.KOI8R = exports.KOI8R_GENERAL_CI;
exports.LATIN1 = exports.LATIN1_SWEDISH_CI;
exports.LATIN2 = exports.LATIN2_GENERAL_CI;
exports.SWE7 = exports.SWE7_SWEDISH_CI;
exports.ASCII = exports.ASCII_GENERAL_CI;
exports.UJIS = exports.UJIS_JAPANESE_CI;
exports.SJIS = exports.SJIS_JAPANESE_CI;
exports.HEBREW = exports.HEBREW_GENERAL_CI;
exports.TIS620 = exports.TIS620_THAI_CI;
exports.EUCKR = exports.EUCKR_KOREAN_CI;
exports.KOI8U = exports.KOI8U_GENERAL_CI;
exports.GB2312 = exports.GB2312_CHINESE_CI;
exports.GREEK = exports.GREEK_GENERAL_CI;
exports.CP1250 = exports.CP1250_GENERAL_CI;
exports.GBK = exports.GBK_CHINESE_CI;
exports.LATIN5 = exports.LATIN5_TURKISH_CI;
exports.ARMSCII8 = exports.ARMSCII8_GENERAL_CI;
exports.UTF8 = exports.UTF8_GENERAL_CI;
exports.UCS2 = exports.UCS2_GENERAL_CI;
exports.CP866 = exports.CP866_GENERAL_CI;
exports.KEYBCS2 = exports.KEYBCS2_GENERAL_CI;
exports.MACCE = exports.MACCE_GENERAL_CI;
exports.MACROMAN = exports.MACROMAN_GENERAL_CI;
exports.CP852 = exports.CP852_GENERAL_CI;
exports.LATIN7 = exports.LATIN7_GENERAL_CI;
exports.UTF8MB4 = exports.UTF8MB4_GENERAL_CI;
exports.CP1251 = exports.CP1251_GENERAL_CI;
exports.UTF16 = exports.UTF16_GENERAL_CI;
exports.UTF16LE = exports.UTF16LE_GENERAL_CI;
exports.CP1256 = exports.CP1256_GENERAL_CI;
exports.CP1257 = exports.CP1257_GENERAL_CI;
exports.UTF32 = exports.UTF32_GENERAL_CI;
exports.CP932 = exports.CP932_JAPANESE_CI;
exports.EUCJPMS = exports.EUCJPMS_JAPANESE_CI;
exports.GB18030 = exports.GB18030_CHINESE_CI;
exports.GEOSTD8 = exports.GEOSTD8_GENERAL_CI;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528818, function(require, module, exports) {


/*

  this seems to be not only shorter, but faster than
  string.replace(/\\/g, '\\\\').
            replace(/\u0008/g, '\\b').
            replace(/\t/g, '\\t').
            replace(/\n/g, '\\n').
            replace(/\f/g, '\\f').
            replace(/\r/g, '\\r').
            replace(/'/g, '\\\'').
            replace(/"/g, '\\"');
  or string.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")
  see http://jsperf.com/string-escape-regexp-vs-json-stringify
  */
function srcEscape(str) {
  return JSON.stringify({
    [str]: 1
  }).slice(1, -3);
}

exports.srcEscape = srcEscape;

let highlightFn;
let cardinalRecommended = false;
try {
  highlightFn = require('cardinal').highlight;
} catch (err) {
  highlightFn = text => {
    if (!cardinalRecommended) {
      // eslint-disable-next-line no-console
      console.log('For nicer debug output consider install cardinal@^2.0.0');
      cardinalRecommended = true;
    }
    return text;
  };
}

/**
 * Prints debug message with code frame, will try to use `cardinal` if available.
 */
function printDebugWithCode(msg, code) {
  // eslint-disable-next-line no-console
  console.log(`\n\n${msg}:\n`);
  // eslint-disable-next-line no-console
  console.log(`${highlightFn(code)}\n`);
}

exports.printDebugWithCode = printDebugWithCode;

/**
 * checks whether the `type` is in the `list`
 */
function typeMatch(type, list, Types) {
  if (Array.isArray(list)) {
    return list.some(t => type === Types[t]);
  }

  return !!list;
}

exports.typeMatch = typeMatch;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528819, function(require, module, exports) {


const LRU = require('lru-cache');

const parserCache = new LRU({
  max: 15000
});

function keyFromFields(type, fields, options, config) {
  let res =
    `${type}` +
    `/${typeof options.nestTables}` +
    `/${options.nestTables}` +
    `/${options.rowsAsArray}` +
    `/${options.supportBigNumbers || config.supportBigNumbers}` +
    `/${options.bigNumberStrings || config.bigNumberStrings}` +
    `/${typeof options.typeCast}` +
    `/${options.timezone || config.timezone}` +
    `/${options.decimalNumbers}` +
    `/${options.dateStrings}`;
  for (let i = 0; i < fields.length; ++i) {
    const field = fields[i];
    res += `/${field.name}:${field.columnType}:${field.flags}:${
      field.characterSet
    }`;

    if (options.nestTables) {
      res += `:${field.table}`
    }
  }
  return res;
}

function getParser(type, fields, options, config, compiler) {
  const key = keyFromFields(type, fields, options, config);
  let parser = parserCache.get(key);

  if (parser) {
    return parser;
  }

  parser = compiler(fields, options, config);
  parserCache.set(key, parser);
  return parser;
}

function setMaxCache(max) {
  parserCache.max = max;
}

function clearCache() {
  parserCache.reset();
}

module.exports = {
  getParser: getParser,
  setMaxCache: setMaxCache,
  clearCache: clearCache
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528820, function(require, module, exports) {


const Packets = require('../packets/index.js');
const Command = require('./command.js');
const CloseStatement = require('./close_statement.js');
const Execute = require('./execute.js');

class PreparedStatementInfo {
  constructor(query, id, columns, parameters, connection) {
    this.query = query;
    this.id = id;
    this.columns = columns;
    this.parameters = parameters;
    this.rowParser = null;
    this._connection = connection;
  }

  close() {
    return this._connection.addCommand(new CloseStatement(this.id));
  }

  execute(parameters, callback) {
    if (typeof parameters === 'function') {
      callback = parameters;
      parameters = [];
    }
    return this._connection.addCommand(
      new Execute({ statement: this, values: parameters }, callback)
    );
  }
}

class Prepare extends Command {
  constructor(options, callback) {
    super();
    this.query = options.sql;
    this.onResult = callback;
    this.id = 0;
    this.fieldCount = 0;
    this.parameterCount = 0;
    this.fields = [];
    this.parameterDefinitions = [];
    this.options = options;
  }

  start(packet, connection) {
    const Connection = connection.constructor;
    this.key = Connection.statementKey(this.options);
    const statement = connection._statements.get(this.key);
    if (statement) {
      if (this.onResult) {
        this.onResult(null, statement);
      }
      return null;
    }
    const cmdPacket = new Packets.PrepareStatement(
      this.query,
      connection.config.charsetNumber
    );
    connection.writePacket(cmdPacket.toPacket(1));
    return Prepare.prototype.prepareHeader;
  }

  prepareHeader(packet, connection) {
    const header = new Packets.PreparedStatementHeader(packet);
    this.id = header.id;
    this.fieldCount = header.fieldCount;
    this.parameterCount = header.parameterCount;
    if (this.parameterCount > 0) {
      return Prepare.prototype.readParameter;
    } if (this.fieldCount > 0) {
      return Prepare.prototype.readField;
    } 
    return this.prepareDone(connection);
    
  }

  readParameter(packet, connection) {
    const def = new Packets.ColumnDefinition(packet, connection.clientEncoding);
    this.parameterDefinitions.push(def);
    if (this.parameterDefinitions.length === this.parameterCount) {
      return Prepare.prototype.parametersEOF;
    }
    return this.readParameter;
  }

  readField(packet, connection) {
    const def = new Packets.ColumnDefinition(packet, connection.clientEncoding);
    this.fields.push(def);
    if (this.fields.length === this.fieldCount) {
      return Prepare.prototype.fieldsEOF;
    }
    return Prepare.prototype.readField;
  }

  parametersEOF(packet, connection) {
    if (!packet.isEOF()) {
      return connection.protocolError('Expected EOF packet after parameters');
    }
    if (this.fieldCount > 0) {
      return Prepare.prototype.readField;
    } 
    return this.prepareDone(connection);
    
  }

  fieldsEOF(packet, connection) {
    if (!packet.isEOF()) {
      return connection.protocolError('Expected EOF packet after fields');
    }
    return this.prepareDone(connection);
  }

  prepareDone(connection) {
    const statement = new PreparedStatementInfo(
      this.query,
      this.id,
      this.fields,
      this.parameterDefinitions,
      connection
    );
    connection._statements.set(this.key, statement);
    if (this.onResult) {
      this.onResult(null, statement);
    }
    return null;
  }
}

module.exports = Prepare;

}, function(modId) { var map = {"../packets/index.js":1619928528778,"./command.js":1619928528808,"./close_statement.js":1619928528821,"./execute.js":1619928528822}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528821, function(require, module, exports) {


const Command = require('./command');
const Packets = require('../packets/index.js');

class CloseStatement extends Command {
  constructor(id) {
    super();
    this.id = id;
  }

  start(packet, connection) {
    connection.writePacket(new Packets.CloseStatement(this.id).toPacket(1));
    return null;
  }
}

module.exports = CloseStatement;

}, function(modId) { var map = {"./command":1619928528808,"../packets/index.js":1619928528778}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528822, function(require, module, exports) {


const Command = require('./command.js');
const Query = require('./query.js');
const Packets = require('../packets/index.js');

const getBinaryParser = require('../parsers/binary_parser.js');

class Execute extends Command {
  constructor(options, callback) {
    super();
    this.statement = options.statement;
    this.sql = options.sql;
    this.values = options.values;
    this.onResult = callback;
    this.parameters = options.values;
    this.insertId = 0;
    this._rows = [];
    this._fields = [];
    this._result = [];
    this._fieldCount = 0;
    this._rowParser = null;
    this._executeOptions = options;
    this._resultIndex = 0;
    this._localStream = null;
    this._unpipeStream = function() {};
    this._streamFactory = options.infileStreamFactory;
    this._connection = null;
  }

  buildParserFromFields(fields, connection) {
    return getBinaryParser(fields, this.options, connection.config);
  }

  start(packet, connection) {
    this._connection = connection;
    this.options = Object.assign({}, connection.config, this._executeOptions);
    const executePacket = new Packets.Execute(
      this.statement.id,
      this.parameters,
      connection.config.charsetNumber,
      connection.config.timezone
    );
    //For reasons why this try-catch is here, please see
    // https://github.com/sidorares/node-mysql2/pull/689
    //For additional discussion, see
    // 1. https://github.com/sidorares/node-mysql2/issues/493
    // 2. https://github.com/sidorares/node-mysql2/issues/187
    // 3. https://github.com/sidorares/node-mysql2/issues/480
    try {
      connection.writePacket(executePacket.toPacket(1));
    } catch (error) {
      this.onResult(error);
    }
    return Execute.prototype.resultsetHeader;
  }

  readField(packet, connection) {
    let fields;
    // disabling for now, but would be great to find reliable way to parse fields only once
    // fields reported by prepare can be empty at all or just incorrect - see #169
    //
    // perfomance optimisation: if we already have this field parsed in statement header, use one from header
    // const field = this.statement.columns.length == this._fieldCount ?
    //  this.statement.columns[this._receivedFieldsCount] : new Packets.ColumnDefinition(packet);
    const field = new Packets.ColumnDefinition(
      packet,
      connection.clientEncoding
    );
    this._receivedFieldsCount++;
    this._fields[this._resultIndex].push(field);
    if (this._receivedFieldsCount === this._fieldCount) {
      fields = this._fields[this._resultIndex];
      this.emit('fields', fields, this._resultIndex);
      return Execute.prototype.fieldsEOF;
    }
    return Execute.prototype.readField;
  }

  fieldsEOF(packet, connection) {
    // check EOF
    if (!packet.isEOF()) {
      return connection.protocolError('Expected EOF packet');
    }
    this._rowParser = this.buildParserFromFields(
      this._fields[this._resultIndex],
      connection
    );
    return Execute.prototype.row;
  }
}

Execute.prototype.done = Query.prototype.done;
Execute.prototype.doneInsert = Query.prototype.doneInsert;
Execute.prototype.resultsetHeader = Query.prototype.resultsetHeader;
Execute.prototype._findOrCreateReadStream =
  Query.prototype._findOrCreateReadStream;
Execute.prototype._streamLocalInfile = Query.prototype._streamLocalInfile;
Execute.prototype.row = Query.prototype.row;
Execute.prototype.stream = Query.prototype.stream;

module.exports = Execute;

}, function(modId) { var map = {"./command.js":1619928528808,"./query.js":1619928528815,"../packets/index.js":1619928528778,"../parsers/binary_parser.js":1619928528823}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528823, function(require, module, exports) {


const FieldFlags = require('../constants/field_flags.js');
const Charsets = require('../constants/charsets.js');
const Types = require('../constants/types.js');
const helpers = require('../helpers');
const genFunc = require('generate-function');
const parserCache = require('./parser_cache.js');
const typeNames = [];
for (const t in Types) {
  typeNames[Types[t]] = t;
}

function readCodeFor(field, config, options, fieldNum) {
  const supportBigNumbers =
    options.supportBigNumbers || config.supportBigNumbers;
  const bigNumberStrings = options.bigNumberStrings || config.bigNumberStrings;
  const timezone = options.timezone || config.timezone;
  const dateStrings = options.dateStrings || config.dateStrings;
  const unsigned = field.flags & FieldFlags.UNSIGNED;
  switch (field.columnType) {
    case Types.TINY:
      return unsigned ? 'packet.readInt8();' : 'packet.readSInt8();';
    case Types.SHORT:
      return unsigned ? 'packet.readInt16();' : 'packet.readSInt16();';
    case Types.LONG:
    case Types.INT24: // in binary protocol int24 is encoded in 4 bytes int32
      return unsigned ? 'packet.readInt32();' : 'packet.readSInt32();';
    case Types.YEAR:
      return 'packet.readInt16()';
    case Types.FLOAT:
      return 'packet.readFloat();';
    case Types.DOUBLE:
      return 'packet.readDouble();';
    case Types.NULL:
      return 'null;';
    case Types.DATE:
    case Types.DATETIME:
    case Types.TIMESTAMP:
    case Types.NEWDATE:
      if (helpers.typeMatch(field.columnType, dateStrings, Types)) {
        return `packet.readDateTimeString(${field.decimals});`;
      }
      return `packet.readDateTime('${timezone}');`;
    case Types.TIME:
      return 'packet.readTimeString()';
    case Types.DECIMAL:
    case Types.NEWDECIMAL:
      if (config.decimalNumbers) {
        return 'packet.parseLengthCodedFloat();';
      }
      return 'packet.readLengthCodedString("ascii");';
    case Types.GEOMETRY:
      return 'packet.parseGeometryValue();';
    case Types.JSON:
      // Since for JSON columns mysql always returns charset 63 (BINARY),
      // we have to handle it according to JSON specs and use "utf8",
      // see https://github.com/sidorares/node-mysql2/issues/409
      return 'JSON.parse(packet.readLengthCodedString("utf8"));';
    case Types.LONGLONG:
      if (!supportBigNumbers) {
        return unsigned
          ? 'packet.readInt64JSNumber();'
          : 'packet.readSInt64JSNumber();';
      }
      if (bigNumberStrings) {
        return unsigned
          ? 'packet.readInt64String();'
          : 'packet.readSInt64String();';
      }
      return unsigned ? 'packet.readInt64();' : 'packet.readSInt64();';

    default:
      if (field.characterSet === Charsets.BINARY) {
        return 'packet.readLengthCodedBuffer();';
      }
      return `packet.readLengthCodedString(CharsetToEncoding[fields[${fieldNum}].characterSet])`;
  }
}

function compile(fields, options, config) {
  const parserFn = genFunc();
  let i = 0;
  const nullBitmapLength = Math.floor((fields.length + 7 + 2) / 8);

  /* eslint-disable no-trailing-spaces */
  /* eslint-disable no-spaced-func */
  /* eslint-disable no-unexpected-multiline */

  parserFn('(function(){')(
    'return function BinaryRow(packet, fields, options, CharsetToEncoding) {'
  );

  if (options.rowsAsArray) {
    parserFn(`const result = new Array(${fields.length});`);
  }

  const resultTables = {};
  let resultTablesArray = [];

  if (options.nestTables === true) {
    for (i = 0; i < fields.length; i++) {
      resultTables[fields[i].table] = 1;
    }
    resultTablesArray = Object.keys(resultTables);
    for (i = 0; i < resultTablesArray.length; i++) {
      parserFn(`this[${helpers.srcEscape(resultTablesArray[i])}] = {};`);
    }
  }

  parserFn('packet.readInt8();'); // status byte
  for (i = 0; i < nullBitmapLength; ++i) {
    parserFn(`const nullBitmaskByte${i} = packet.readInt8();`);
  }

  let lvalue = '';
  let currentFieldNullBit = 4;
  let nullByteIndex = 0;
  let fieldName = '';
  let tableName = '';

  for (i = 0; i < fields.length; i++) {
    fieldName = helpers.srcEscape(fields[i].name);
    parserFn(`// ${fieldName}: ${typeNames[fields[i].columnType]}`);

    if (typeof options.nestTables === 'string') {
      tableName = helpers.srcEscape(fields[i].table);
      lvalue = `this[${helpers.srcEscape(
        fields[i].table + options.nestTables + fields[i].name
      )}]`;
    } else if (options.nestTables === true) {
      tableName = helpers.srcEscape(fields[i].table);
      lvalue = `this[${tableName}][${fieldName}]`;
    } else if (options.rowsAsArray) {
      lvalue = `result[${i.toString(10)}]`;
    } else {
      lvalue = `this[${helpers.srcEscape(fields[i].name)}]`;
    }

    // TODO: this used to be an optimisation ( if column marked as NOT_NULL don't include code to check null
    // bitmap at all, but it seems that we can't rely on this flag, see #178
    // TODO: benchmark performance difference
    //
    // if (fields[i].flags & FieldFlags.NOT_NULL) { // don't need to check null bitmap if field can't be null.
    //  result.push(lvalue + ' = ' + readCodeFor(fields[i], config));
    // } else if (fields[i].columnType == Types.NULL) {
    //  result.push(lvalue + ' = null;');
    // } else {
    parserFn(`if (nullBitmaskByte${nullByteIndex} & ${currentFieldNullBit})`);
    parserFn(`${lvalue} = null;`);
    parserFn('else');
    parserFn(`${lvalue} = ${readCodeFor(fields[i], config, options, i)}`);
    // }
    currentFieldNullBit *= 2;
    if (currentFieldNullBit === 0x100) {
      currentFieldNullBit = 1;
      nullByteIndex++;
    }
  }

  if (options.rowsAsArray) {
    parserFn('return result;');
  }

  parserFn('};')('})()');

  /* eslint-enable no-trailing-spaces */
  /* eslint-enable no-spaced-func */
  /* eslint-enable no-unexpected-multiline */

  if (config.debug) {
    helpers.printDebugWithCode(
      'Compiled binary protocol row parser',
      parserFn.toString()
    );
  }
  return parserFn.toFunction();
}

function getBinaryParser(fields, options, config) {
  return parserCache.getParser('binary', fields, options, config, compile);
}

module.exports = getBinaryParser;

}, function(modId) { var map = {"../constants/field_flags.js":1619928528824,"../constants/charsets.js":1619928528817,"../constants/types.js":1619928528783,"../helpers":1619928528818,"./parser_cache.js":1619928528819}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528824, function(require, module, exports) {


// Manually extracted from mysql-5.5.23/include/mysql_com.h
exports.NOT_NULL = 1; /* Field can't be NULL */
exports.PRI_KEY = 2; /* Field is part of a primary key */
exports.UNIQUE_KEY = 4; /* Field is part of a unique key */
exports.MULTIPLE_KEY = 8; /* Field is part of a key */
exports.BLOB = 16; /* Field is a blob */
exports.UNSIGNED = 32; /* Field is unsigned */
exports.ZEROFILL = 64; /* Field is zerofill */
exports.BINARY = 128; /* Field is binary   */

/* The following are only sent to new clients */
exports.ENUM = 256; /* field is an enum */
exports.AUTO_INCREMENT = 512; /* field is a autoincrement field */
exports.TIMESTAMP = 1024; /* Field is a timestamp */
exports.SET = 2048; /* field is a set */
exports.NO_DEFAULT_VALUE = 4096; /* Field doesn't have default value */
exports.ON_UPDATE_NOW = 8192; /* Field is set to NOW on UPDATE */
exports.NUM = 32768; /* Field is num (for clients) */

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528825, function(require, module, exports) {


const Command = require('./command');
const CommandCode = require('../constants/commands');
const Packet = require('../packets/packet');

// TODO: time statistics?
// usefull for queue size and network latency monitoring
// store created,sent,reply timestamps
class Ping extends Command {
  constructor(callback) {
    super();
    this.onResult = callback;
  }

  start(packet, connection) {
    const ping = new Packet(
      0,
      Buffer.from([1, 0, 0, 0, CommandCode.PING]),
      0,
      5
    );
    connection.writePacket(ping);
    return Ping.prototype.pingResponse;
  }

  pingResponse() {
    // TODO: check it's OK packet. error check already done in caller
    if (this.onResult) {
      process.nextTick(this.onResult.bind(this));
    }
    return null;
  }
}

module.exports = Ping;

}, function(modId) { var map = {"./command":1619928528808,"../constants/commands":1619928528785,"../packets/packet":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528826, function(require, module, exports) {


const Command = require('./command');
const Packets = require('../packets');

class RegisterSlave extends Command {
  constructor(opts, callback) {
    super();
    this.onResult = callback;
    this.opts = opts;
  }

  start(packet, connection) {
    const newPacket = new Packets.RegisterSlave(this.opts);
    connection.writePacket(newPacket.toPacket(1));
    return RegisterSlave.prototype.registerResponse;
  }

  registerResponse() {
    if (this.onResult) {
      process.nextTick(this.onResult.bind(this));
    }
    return null;
  }
}

module.exports = RegisterSlave;

}, function(modId) { var map = {"./command":1619928528808,"../packets":1619928528778}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528827, function(require, module, exports) {


const Command = require('./command');
const Packets = require('../packets');

const eventParsers = [];

class BinlogEventHeader {
  constructor(packet) {
    this.timestamp = packet.readInt32();
    this.eventType = packet.readInt8();
    this.serverId = packet.readInt32();
    this.eventSize = packet.readInt32();
    this.logPos = packet.readInt32();
    this.flags = packet.readInt16();
  }
}

class BinlogDump extends Command {
  constructor(opts) {
    super();
    // this.onResult = callback;
    this.opts = opts;
  }

  start(packet, connection) {
    const newPacket = new Packets.BinlogDump(this.opts);
    connection.writePacket(newPacket.toPacket(1));
    return BinlogDump.prototype.binlogData;
  }

  binlogData(packet) {
    // ok - continue consuming events
    // error - error
    // eof - end of binlog
    if (packet.isEOF()) {
      this.emit('eof');
      return null;
    }
    // binlog event header
    packet.readInt8();
    const header = new BinlogEventHeader(packet);
    const EventParser = eventParsers[header.eventType];
    let event;
    if (EventParser) {
      event = new EventParser(packet);
    } else {
      event = {
        name: 'UNKNOWN'
      };
    }
    event.header = header;
    this.emit('event', event);
    return BinlogDump.prototype.binlogData;
  }
}

class RotateEvent {
  constructor(packet) {
    this.pposition = packet.readInt32();
    // TODO: read uint64 here
    packet.readInt32(); // positionDword2
    this.nextBinlog = packet.readString();
    this.name = 'RotateEvent';
  }
}

class FormatDescriptionEvent {
  constructor(packet) {
    this.binlogVersion = packet.readInt16();
    this.serverVersion = packet.readString(50).replace(/\u0000.*/, ''); // eslint-disable-line no-control-regex
    this.createTimestamp = packet.readInt32();
    this.eventHeaderLength = packet.readInt8(); // should be 19
    this.eventsLength = packet.readBuffer();
    this.name = 'FormatDescriptionEvent';
  }
}

class QueryEvent {
  constructor(packet) {
    const parseStatusVars = require('../packets/binlog_query_statusvars.js');
    this.slaveProxyId = packet.readInt32();
    this.executionTime = packet.readInt32();
    const schemaLength = packet.readInt8();
    this.errorCode = packet.readInt16();
    const statusVarsLength = packet.readInt16();
    const statusVars = packet.readBuffer(statusVarsLength);
    this.schema = packet.readString(schemaLength);
    packet.readInt8(); // should be zero
    this.statusVars = parseStatusVars(statusVars);
    this.query = packet.readString();
    this.name = 'QueryEvent';
  }
}

class XidEvent {
  constructor(packet) {
    this.binlogVersion = packet.readInt16();
    this.xid = packet.readInt64();
    this.name = 'XidEvent';
  }
}

eventParsers[2] = QueryEvent;
eventParsers[4] = RotateEvent;
eventParsers[15] = FormatDescriptionEvent;
eventParsers[16] = XidEvent;

module.exports = BinlogDump;

}, function(modId) { var map = {"./command":1619928528808,"../packets":1619928528778,"../packets/binlog_query_statusvars.js":1619928528828}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528828, function(require, module, exports) {


// http://dev.mysql.com/doc/internals/en/query-event.html

const keys = {
  FLAGS2: 0,
  SQL_MODE: 1,
  CATALOG: 2,
  AUTO_INCREMENT: 3,
  CHARSET: 4,
  TIME_ZONE: 5,
  CATALOG_NZ: 6,
  LC_TIME_NAMES: 7,
  CHARSET_DATABASE: 8,
  TABLE_MAP_FOR_UPDATE: 9,
  MASTER_DATA_WRITTEN: 10,
  INVOKERS: 11,
  UPDATED_DB_NAMES: 12,
  MICROSECONDS: 3
};

module.exports = function parseStatusVars(buffer) {
  const result = {};
  let offset = 0;
  let key, length, prevOffset;
  while (offset < buffer.length) {
    key = buffer[offset++];
    switch (key) {
      case keys.FLAGS2:
        result.flags = buffer.readUInt32LE(offset);
        offset += 4;
        break;
      case keys.SQL_MODE:
        // value is 8 bytes, but all dcumented flags are in first 4 bytes
        result.sqlMode = buffer.readUInt32LE(offset);
        offset += 8;
        break;
      case keys.CATALOG:
        length = buffer[offset++];
        result.catalog = buffer.toString('utf8', offset, offset + length);
        offset += length + 1; // null byte after string
        break;
      case keys.CHARSET:
        result.clientCharset = buffer.readUInt16LE(offset);
        result.connectionCollation = buffer.readUInt16LE(offset + 2);
        result.serverCharset = buffer.readUInt16LE(offset + 4);
        offset += 6;
        break;
      case keys.TIME_ZONE:
        length = buffer[offset++];
        result.timeZone = buffer.toString('utf8', offset, offset + length);
        offset += length; // no null byte
        break;
      case keys.CATALOG_NZ:
        length = buffer[offset++];
        result.catalogNz = buffer.toString('utf8', offset, offset + length);
        offset += length; // no null byte
        break;
      case keys.LC_TIME_NAMES:
        result.lcTimeNames = buffer.readUInt16LE(offset);
        offset += 2;
        break;
      case keys.CHARSET_DATABASE:
        result.schemaCharset = buffer.readUInt16LE(offset);
        offset += 2;
        break;
      case keys.TABLE_MAP_FOR_UPDATE:
        result.mapForUpdate1 = buffer.readUInt32LE(offset);
        result.mapForUpdate2 = buffer.readUInt32LE(offset + 4);
        offset += 8;
        break;
      case keys.MASTER_DATA_WRITTEN:
        result.masterDataWritten = buffer.readUInt32LE(offset);
        offset += 4;
        break;
      case keys.INVOKERS:
        length = buffer[offset++];
        result.invokerUsername = buffer.toString(
          'utf8',
          offset,
          offset + length
        );
        offset += length;
        length = buffer[offset++];
        result.invokerHostname = buffer.toString(
          'utf8',
          offset,
          offset + length
        );
        offset += length;
        break;
      case keys.UPDATED_DB_NAMES:
        length = buffer[offset++];
        // length - number of null-terminated strings
        result.updatedDBs = []; // we'll store them as array here
        for (; length; --length) {
          prevOffset = offset;
          // fast forward to null terminating byte
          while (buffer[offset++] && offset < buffer.length) {
            // empty body, everything inside while condition
          }
          result.updatedDBs.push(
            buffer.toString('utf8', prevOffset, offset - 1)
          );
        }
        break;
      case keys.MICROSECONDS:
        result.microseconds =
          // REVIEW: INVALID UNKNOWN VARIABLE!
          buffer.readInt16LE(offset) + (buffer[offset + 2] << 16);
        offset += 3;
    }
  }
  return result;
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528829, function(require, module, exports) {


const Command = require('./command.js');
const Packets = require('../packets/index.js');
const ClientHandshake = require('./client_handshake.js');
const CharsetToEncoding = require('../constants/charset_encodings.js');

class ChangeUser extends Command {
  constructor(options, callback) {
    super();
    this.onResult = callback;
    this.user = options.user;
    this.password = options.password;
    this.database = options.database;
    this.passwordSha1 = options.passwordSha1;
    this.charsetNumber = options.charsetNumber;
    this.currentConfig = options.currentConfig;
  }
  start(packet, connection) {
    const newPacket = new Packets.ChangeUser({
      flags: connection.config.clientFlags,
      user: this.user,
      database: this.database,
      charsetNumber: this.charsetNumber,
      password: this.password,
      passwordSha1: this.passwordSha1,
      authPluginData1: connection._handshakePacket.authPluginData1,
      authPluginData2: connection._handshakePacket.authPluginData2
    });
    this.currentConfig.user = this.user;
    this.currentConfig.password = this.password;
    this.currentConfig.database = this.database;
    this.currentConfig.charsetNumber = this.charsetNumber;
    connection.clientEncoding = CharsetToEncoding[this.charsetNumber];
    // reset prepared statements cache as all statements become invalid after changeUser
    connection._statements.reset();
    connection.writePacket(newPacket.toPacket());
    return ChangeUser.prototype.handshakeResult;
  }
}

ChangeUser.prototype.handshakeResult =
  ClientHandshake.prototype.handshakeResult;
ChangeUser.prototype.calculateNativePasswordAuthToken =
  ClientHandshake.prototype.calculateNativePasswordAuthToken;

module.exports = ChangeUser;

}, function(modId) { var map = {"./command.js":1619928528808,"../packets/index.js":1619928528778,"./client_handshake.js":1619928528807,"../constants/charset_encodings.js":1619928528789}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528830, function(require, module, exports) {


const Command = require('./command.js');
const CommandCode = require('../constants/commands.js');
const Packet = require('../packets/packet.js');

class Quit extends Command {
  constructor(callback) {
    super();
    this.done = callback;
  }

  start(packet, connection) {
    connection._closing = true;
    const quit = new Packet(
      0,
      Buffer.from([1, 0, 0, 0, CommandCode.QUIT]),
      0,
      5
    );
    if (this.done) {
      this.done();
    }
    connection.writePacket(quit);
    return null;
  }
}

module.exports = Quit;

}, function(modId) { var map = {"./command.js":1619928528808,"../constants/commands.js":1619928528785,"../packets/packet.js":1619928528775}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528831, function(require, module, exports) {


const urlParse = require('url').parse;
const ClientConstants = require('./constants/client');
const Charsets = require('./constants/charsets');
let SSLProfiles = null;

const validOptions = {
  authPlugins: 1,
  authSwitchHandler: 1,
  bigNumberStrings: 1,
  charset: 1,
  charsetNumber: 1,
  compress: 1,
  connectAttributes: 1,
  connectTimeout: 1,
  database: 1,
  dateStrings: 1,
  debug: 1,
  decimalNumbers: 1,
  enableKeepAlive: 1,
  flags: 1,
  host: 1,
  insecureAuth: 1,
  isServer: 1,
  keepAliveInitialDelay: 1,
  localAddress: 1,
  maxPreparedStatements: 1,
  multipleStatements: 1,
  namedPlaceholders: 1,
  nestTables: 1,
  password: 1,
  passwordSha1: 1,
  pool: 1,
  port: 1,
  queryFormat: 1,
  rowsAsArray: 1,
  socketPath: 1,
  ssl: 1,
  stream: 1,
  stringifyObjects: 1,
  supportBigNumbers: 1,
  timezone: 1,
  trace: 1,
  typeCast: 1,
  uri: 1,
  user: 1,
  // These options are used for Pool
  connectionLimit: 1,
  Promise: 1,
  queueLimit: 1,
  waitForConnections: 1
};

class ConnectionConfig {
  constructor(options) {
    if (typeof options === 'string') {
      options = ConnectionConfig.parseUrl(options);
    } else if (options && options.uri) {
      const uriOptions = ConnectionConfig.parseUrl(options.uri);
      for (const key in uriOptions) {
        if (!Object.prototype.hasOwnProperty.call(uriOptions, key)) continue;
        if (options[key]) continue;
        options[key] = uriOptions[key];
      }
    }
    for (const key in options) {
      if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
      if (validOptions[key] !== 1) {
        // REVIEW: Should this be emitted somehow?
        // eslint-disable-next-line no-console
        console.error(
          `Ignoring invalid configuration option passed to Connection: ${key}. This is currently a warning, but in future versions of MySQL2, an error will be thrown if you pass an invalid configuration option to a Connection`
        );
      }
    }
    this.isServer = options.isServer;
    this.stream = options.stream;
    this.host = options.host || 'localhost';
    this.port = options.port || 3306;
    this.localAddress = options.localAddress;
    this.socketPath = options.socketPath;
    this.user = options.user || undefined;
    this.password = options.password || undefined;
    this.passwordSha1 = options.passwordSha1 || undefined;
    this.database = options.database;
    this.connectTimeout = isNaN(options.connectTimeout)
      ? 10 * 1000
      : options.connectTimeout;
    this.insecureAuth = options.insecureAuth || false;
    this.supportBigNumbers = options.supportBigNumbers || false;
    this.bigNumberStrings = options.bigNumberStrings || false;
    this.decimalNumbers = options.decimalNumbers || false;
    this.dateStrings = options.dateStrings || false;
    this.debug = options.debug;
    this.trace = options.trace !== false;
    this.stringifyObjects = options.stringifyObjects || false;
    this.enableKeepAlive = !!options.enableKeepAlive;
    this.keepAliveInitialDelay = options.keepAliveInitialDelay || 0;
    if (
      options.timezone &&
      !/^(?:local|Z|[ +-]\d\d:\d\d)$/.test(options.timezone)
    ) {
      // strictly supports timezones specified by mysqljs/mysql:
      // https://github.com/mysqljs/mysql#user-content-connection-options
      // eslint-disable-next-line no-console
      console.error(
        `Ignoring invalid timezone passed to Connection: ${options.timezone}. This is currently a warning, but in future versions of MySQL2, an error will be thrown if you pass an invalid configuration option to a Connection`
      );
      // SqlStrings falls back to UTC on invalid timezone
      this.timezone = 'Z';
    } else {
      this.timezone = options.timezone || 'local';
    }
    this.queryFormat = options.queryFormat;
    this.pool = options.pool || undefined;
    this.ssl =
      typeof options.ssl === 'string'
        ? ConnectionConfig.getSSLProfile(options.ssl)
        : options.ssl || false;
    this.multipleStatements = options.multipleStatements || false;
    this.rowsAsArray = options.rowsAsArray || false;
    this.namedPlaceholders = options.namedPlaceholders || false;
    this.nestTables =
      options.nestTables === undefined ? undefined : options.nestTables;
    this.typeCast = options.typeCast === undefined ? true : options.typeCast;
    if (this.timezone[0] === ' ') {
      // "+" is a url encoded char for space so it
      // gets translated to space when giving a
      // connection string..
      this.timezone = `+${this.timezone.substr(1)}`;
    }
    if (this.ssl) {
      if (typeof this.ssl !== 'object') {
        throw new TypeError(
          `SSL profile must be an object, instead it's a ${typeof this.ssl}`
        );
      }
      // Default rejectUnauthorized to true
      this.ssl.rejectUnauthorized = this.ssl.rejectUnauthorized !== false;
    }
    this.maxPacketSize = 0;
    this.charsetNumber = options.charset
      ? ConnectionConfig.getCharsetNumber(options.charset)
      : options.charsetNumber || Charsets.UTF8MB4_UNICODE_CI;
    this.compress = options.compress || false;
    this.authPlugins = options.authPlugins;
    this.authSwitchHandler = options.authSwitchHandler;
    this.clientFlags = ConnectionConfig.mergeFlags(
      ConnectionConfig.getDefaultFlags(options),
      options.flags || ''
    );
    this.connectAttributes = options.connectAttributes;
    this.maxPreparedStatements = options.maxPreparedStatements || 16000;
  }

  static mergeFlags(default_flags, user_flags) {
    let flags = 0x0,
      i;
    if (!Array.isArray(user_flags)) {
      user_flags = String(user_flags || '')
        .toUpperCase()
        .split(/\s*,+\s*/);
    }
    // add default flags unless "blacklisted"
    for (i in default_flags) {
      if (user_flags.indexOf(`-${default_flags[i]}`) >= 0) {
        continue;
      }
      flags |= ClientConstants[default_flags[i]] || 0x0;
    }
    // add user flags unless already already added
    for (i in user_flags) {
      if (user_flags[i][0] === '-') {
        continue;
      }
      if (default_flags.indexOf(user_flags[i]) >= 0) {
        continue;
      }
      flags |= ClientConstants[user_flags[i]] || 0x0;
    }
    return flags;
  }

  static getDefaultFlags(options) {
    const defaultFlags = [
      'LONG_PASSWORD',
      'FOUND_ROWS',
      'LONG_FLAG',
      'CONNECT_WITH_DB',
      'ODBC',
      'LOCAL_FILES',
      'IGNORE_SPACE',
      'PROTOCOL_41',
      'IGNORE_SIGPIPE',
      'TRANSACTIONS',
      'RESERVED',
      'SECURE_CONNECTION',
      'MULTI_RESULTS',
      'TRANSACTIONS',
      'SESSION_TRACK'
    ];
    if (options && options.multipleStatements) {
      defaultFlags.push('MULTI_STATEMENTS');
    }
    defaultFlags.push('PLUGIN_AUTH');
    defaultFlags.push('PLUGIN_AUTH_LENENC_CLIENT_DATA');

    if (options && options.connectAttributes) {
      defaultFlags.push('CONNECT_ATTRS');
    }
    return defaultFlags;
  }

  static getCharsetNumber(charset) {
    const num = Charsets[charset.toUpperCase()];
    if (num === undefined) {
      throw new TypeError(`Unknown charset '${charset}'`);
    }
    return num;
  }

  static getSSLProfile(name) {
    if (!SSLProfiles) {
      SSLProfiles = require('./constants/ssl_profiles.js');
    }
    const ssl = SSLProfiles[name];
    if (ssl === undefined) {
      throw new TypeError(`Unknown SSL profile '${name}'`);
    }
    return ssl;
  }

  static parseUrl(url) {
    url = urlParse(url, true);
    const options = {
      host: url.hostname,
      port: url.port,
      database: url.pathname.substr(1)
    };
    if (url.auth) {
      const auth = url.auth.split(':');
      options.user = auth[0];
      options.password = auth[1];
    }
    if (url.query) {
      for (const key in url.query) {
        const value = url.query[key];
        try {
          // Try to parse this as a JSON expression first
          options[key] = JSON.parse(value);
        } catch (err) {
          // Otherwise assume it is a plain string
          options[key] = value;
        }
      }
    }
    return options;
  }
}

module.exports = ConnectionConfig;

}, function(modId) { var map = {"./constants/client":1619928528787,"./constants/charsets":1619928528817,"./constants/ssl_profiles.js":1619928528832}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528832, function(require, module, exports) {


// Certificate for Amazon RDS (Updated for 2019)
// https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
// https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless.html#aurora-serverless.tls
exports['Amazon RDS'] = {
  ca: [
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID9DCCAtygAwIBAgIBQjANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUwOTExMzFaFw0y\n' +
      'MDAzMDUwOTExMzFaMIGKMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEbMBkGA1UEAwwSQW1hem9uIFJE\n' +
      'UyBSb290IENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuD8nrZ8V\n' +
      'u+VA8yVlUipCZIKPTDcOILYpUe8Tct0YeQQr0uyl018StdBsa3CjBgvwpDRq1HgF\n' +
      'Ji2N3+39+shCNspQeE6aYU+BHXhKhIIStt3r7gl/4NqYiDDMWKHxHq0nsGDFfArf\n' +
      'AOcjZdJagOMqb3fF46flc8k2E7THTm9Sz4L7RY1WdABMuurpICLFE3oHcGdapOb9\n' +
      'T53pQR+xpHW9atkcf3pf7gbO0rlKVSIoUenBlZipUlp1VZl/OD/E+TtRhDDNdI2J\n' +
      'P/DSMM3aEsq6ZQkfbz/Ilml+Lx3tJYXUDmp+ZjzMPLk/+3beT8EhrwtcG3VPpvwp\n' +
      'BIOqsqVVTvw/CwIDAQABo2MwYTAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUw\n' +
      'AwEB/zAdBgNVHQ4EFgQUTgLurD72FchM7Sz1BcGPnIQISYMwHwYDVR0jBBgwFoAU\n' +
      'TgLurD72FchM7Sz1BcGPnIQISYMwDQYJKoZIhvcNAQEFBQADggEBAHZcgIio8pAm\n' +
      'MjHD5cl6wKjXxScXKtXygWH2BoDMYBJF9yfyKO2jEFxYKbHePpnXB1R04zJSWAw5\n' +
      '2EUuDI1pSBh9BA82/5PkuNlNeSTB3dXDD2PEPdzVWbSKvUB8ZdooV+2vngL0Zm4r\n' +
      '47QPyd18yPHrRIbtBtHR/6CwKevLZ394zgExqhnekYKIqqEX41xsUV0Gm6x4vpjf\n' +
      '2u6O/+YE2U+qyyxHE5Wd5oqde0oo9UUpFETJPVb6Q2cEeQib8PBAyi0i6KnF+kIV\n' +
      'A9dY7IHSubtCK/i8wxMVqfd5GtbA8mmpeJFwnDvm9rBEsHybl08qlax9syEwsUYr\n' +
      '/40NawZfTUU=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEATCCAumgAwIBAgIBRDANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzMDZaFw0y\n' +
      'MDAzMDUyMjAzMDZaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJE\n' +
      'UyBhcC1ub3J0aGVhc3QtMSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\n' +
      'ggEBAMmM2B4PfTXCZjbZMWiDPyxvk/eeNwIRJAhfzesiGUiLozX6CRy3rwC1ZOPV\n' +
      'AcQf0LB+O8wY88C/cV+d4Q2nBDmnk+Vx7o2MyMh343r5rR3Na+4izd89tkQVt0WW\n' +
      'vO21KRH5i8EuBjinboOwAwu6IJ+HyiQiM0VjgjrmEr/YzFPL8MgHD/YUHehqjACn\n' +
      'C0+B7/gu7W4qJzBL2DOf7ub2qszGtwPE+qQzkCRDwE1A4AJmVE++/FLH2Zx78Egg\n' +
      'fV1sUxPtYgjGH76VyyO6GNKM6rAUMD/q5mnPASQVIXgKbupr618bnH+SWHFjBqZq\n' +
      'HvDGPMtiiWII41EmGUypyt5AbysCAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEGMBIG\n' +
      'A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFIiKM0Q6n1K4EmLxs3ZXxINbwEwR\n' +
      'MB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEBBQUA\n' +
      'A4IBAQBezGbE9Rw/k2e25iGjj5n8r+M3dlye8ORfCE/dijHtxqAKasXHgKX8I9Tw\n' +
      'JkBiGWiuzqn7gO5MJ0nMMro1+gq29qjZnYX1pDHPgsRjUX8R+juRhgJ3JSHijRbf\n' +
      '4qNJrnwga7pj94MhcLq9u0f6dxH6dXbyMv21T4TZMTmcFduf1KgaiVx1PEyJjC6r\n' +
      'M+Ru+A0eM+jJ7uCjUoZKcpX8xkj4nmSnz9NMPog3wdOSB9cAW7XIc5mHa656wr7I\n' +
      'WJxVcYNHTXIjCcng2zMKd1aCcl2KSFfy56sRfT7J5Wp69QSr+jq8KM55gw8uqAwi\n' +
      'VPrXn2899T1rcTtFYFP16WXjGuc0\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEATCCAumgAwIBAgIBRTANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzMTlaFw0y\n' +
      'MDAzMDUyMjAzMTlaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJE\n' +
      'UyBhcC1zb3V0aGVhc3QtMSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\n' +
      'ggEBANaXElmSEYt/UtxHFsARFhSUahTf1KNJzR0Dmay6hqOXQuRVbKRwPd19u5vx\n' +
      'DdF1sLT7D69IK3VDnUiQScaCv2Dpu9foZt+rLx+cpx1qiQd1UHrvqq8xPzQOqCdC\n' +
      'RFStq6yVYZ69yfpfoI67AjclMOjl2Vph3ftVnqP0IgVKZdzeC7fd+umGgR9xY0Qr\n' +
      'Ubhd/lWdsbNvzK3f1TPWcfIKQnpvSt85PIEDJir6/nuJUKMtmJRwTymJf0i+JZ4x\n' +
      '7dJa341p2kHKcHMgOPW7nJQklGBA70ytjUV6/qebS3yIugr/28mwReflg3TJzVDl\n' +
      'EOvi6pqbqNbkMuEwGDCmEQIVqgkCAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEGMBIG\n' +
      'A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFAu93/4k5xbWOsgdCdn+/KdiRuit\n' +
      'MB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEBBQUA\n' +
      'A4IBAQBlcjSyscpPjf5+MgzMuAsCxByqUt+WFspwcMCpwdaBeHOPSQrXNqX2Sk6P\n' +
      'kth6oCivA64trWo8tFMvPYlUA1FYVD5WpN0kCK+P5pD4KHlaDsXhuhClJzp/OP8t\n' +
      'pOyUr5109RHLxqoKB5J5m1XA7rgcFjnMxwBSWFe3/4uMk/+4T53YfCVXuc6QV3i7\n' +
      'I/2LAJwFf//pTtt6fZenYfCsahnr2nvrNRNyAxcfvGZ/4Opn/mJtR6R/AjvQZHiR\n' +
      'bkRNKF2GW0ueK5W4FkZVZVhhX9xh1Aj2Ollb+lbOqADaVj+AT3PoJPZ3MPQHKCXm\n' +
      'xwG0LOLlRr/TfD6li1AfOVTAJXv9\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEATCCAumgAwIBAgIBRjANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzMjRaFw0y\n' +
      'MDAzMDUyMjAzMjRaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJE\n' +
      'UyBhcC1zb3V0aGVhc3QtMiBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\n' +
      'ggEBAJqBAJutz69hFOh3BtLHZTbwE8eejGGKayn9hu98YMDPzWzGXWCmW+ZYWELA\n' +
      'cY3cNWNF8K4FqKXFr2ssorBYim1UtYFX8yhydT2hMD5zgQ2sCGUpuidijuPA6zaq\n' +
      'Z3tdhVR94f0q8mpwpv2zqR9PcqaGDx2VR1x773FupRPRo7mEW1vC3IptHCQlP/zE\n' +
      '7jQiLl28bDIH2567xg7e7E9WnZToRnhlYdTaDaJsHTzi5mwILi4cihSok7Shv/ME\n' +
      'hnukvxeSPUpaVtFaBhfBqq055ePq9I+Ns4KGreTKMhU0O9fkkaBaBmPaFgmeX/XO\n' +
      'n2AX7gMouo3mtv34iDTZ0h6YCGkCAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEGMBIG\n' +
      'A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFIlQnY0KHYWn1jYumSdJYfwj/Nfw\n' +
      'MB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEBBQUA\n' +
      'A4IBAQA0wVU6/l41cTzHc4azc4CDYY2Wd90DFWiH9C/mw0SgToYfCJ/5Cfi0NT/Y\n' +
      'PRnk3GchychCJgoPA/k9d0//IhYEAIiIDjyFVgjbTkKV3sh4RbdldKVOUB9kumz/\n' +
      'ZpShplsGt3z4QQiVnKfrAgqxWDjR0I0pQKkxXa6Sjkicos9LQxVtJ0XA4ieG1E7z\n' +
      'zJr+6t80wmzxvkInSaWP3xNJK9azVRTrgQZQlvkbpDbExl4mNTG66VD3bAp6t3Wa\n' +
      'B49//uDdfZmPkqqbX+hsxp160OH0rxJppwO3Bh869PkDnaPEd/Pxw7PawC+li0gi\n' +
      'NRV8iCEx85aFxcyOhqn0WZOasxee\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/zCCAuegAwIBAgIBRzANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzMzFaFw0y\n' +
      'MDAzMDUyMjAzMzFaMIGSMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEjMCEGA1UEAwwaQW1hem9uIFJE\n' +
      'UyBldS1jZW50cmFsLTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIB\n' +
      'AQDFtP2dhSLuaPOI4ZrrPWsK4OY9ocQBp3yApH1KJYmI9wpQKZG/KCH2E6Oo7JAw\n' +
      'QORU519r033T+FO2Z7pFPlmz1yrxGXyHpJs8ySx3Yo5S8ncDCdZJCLmtPiq/hahg\n' +
      '5/0ffexMFUCQaYicFZsrJ/cStdxUV+tSw2JQLD7UxS9J97LQWUPyyG+ZrjYVTVq+\n' +
      'zudnFmNSe4QoecXMhAFTGJFQXxP7nhSL9Ao5FGgdXy7/JWeWdQIAj8ku6cBDKPa6\n' +
      'Y6kP+ak+In+Lye8z9qsCD/afUozfWjPR2aA4JoIZVF8dNRShIMo8l0XfgfM2q0+n\n' +
      'ApZWZ+BjhIO5XuoUgHS3D2YFAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNV\n' +
      'HRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBRm4GsWIA/M6q+tK8WGHWDGh2gcyTAf\n' +
      'BgNVHSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOC\n' +
      'AQEAHpMmeVQNqcxgfQdbDIi5UIy+E7zZykmtAygN1XQrvga9nXTis4kOTN6g5/+g\n' +
      'HCx7jIXeNJzAbvg8XFqBN84Quqgpl/tQkbpco9Jh1HDs558D5NnZQxNqH5qXQ3Mm\n' +
      'uPgCw0pYcPOa7bhs07i+MdVwPBsX27CFDtsgAIru8HvKxY1oTZrWnyIRo93tt/pk\n' +
      'WuItVMVHjaQZVfTCow0aDUbte6Vlw82KjUFq+n2NMSCJDiDKsDDHT6BJc4AJHIq3\n' +
      '/4Z52MSC9KMr0yAaaoWfW/yMEj9LliQauAgwVjArF4q78rxpfKTG9Rfd8U1BZANP\n' +
      '7FrFMN0ThjfA1IvmOYcgskY5bQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBSDANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzMzVaFw0y\n' +
      'MDAzMDUyMjAzMzVaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyBldS13ZXN0LTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCx\n' +
      'PdbqQ0HKRj79Pmocxvjc+P6i4Ux24kgFIl+ckiir1vzkmesc3a58gjrMlCksEObt\n' +
      'Yihs5IhzEq1ePT0gbfS9GYFp34Uj/MtPwlrfCBWG4d2TcrsKRHr1/EXUYhWqmdrb\n' +
      'RhX8XqoRhVkbF/auzFSBhTzcGGvZpQ2KIaxRcQfcXlMVhj/pxxAjh8U4F350Fb0h\n' +
      'nX1jw4/KvEreBL0Xb2lnlGTkwVxaKGSgXEnOgIyOFdOQc61vdome0+eeZsP4jqeR\n' +
      'TGYJA9izJsRbe2YJxHuazD+548hsPlM3vFzKKEVURCha466rAaYAHy3rKur3HYQx\n' +
      'Yt+SoKcEz9PXuSGj96ejAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBTebg//h2oeXbZjQ4uuoiuLYzuiPDAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOCAQEA\n' +
      'TikPaGeZasTPw+4RBemlsyPAjtFFQLo7ddaFdORLgdEysVf8aBqndvbA6MT/v4lj\n' +
      'GtEtUdF59ZcbWOrVm+fBZ2h/jYJ59dYF/xzb09nyRbdMSzB9+mkSsnOMqluq5y8o\n' +
      'DY/PfP2vGhEg/2ZncRC7nlQU1Dm8F4lFWEiQ2fi7O1cW852Vmbq61RIfcYsH/9Ma\n' +
      'kpgk10VZ75b8m3UhmpZ/2uRY+JEHImH5WpcTJ7wNiPNJsciZMznGtrgOnPzYco8L\n' +
      'cDleOASIZifNMQi9PKOJKvi0ITz0B/imr8KBsW0YjZVJ54HMa7W1lwugSM7aMAs+\n' +
      'E3Sd5lS+SHwWaOCHwhOEVA==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBSTANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzNDBaFw0y\n' +
      'MDAzMDUyMjAzNDBaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyBzYS1lYXN0LTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCU\n' +
      'X4OBnQ5xA6TLJAiFEI6l7bUWjoVJBa/VbMdCCSs2i2dOKmqUaXu2ix2zcPILj3lZ\n' +
      'GMk3d/2zvTK/cKhcFrewHUBamTeVHdEmynhMQamqNmkM4ptYzFcvEUw1TGxHT4pV\n' +
      'Q6gSN7+/AJewQvyHexHo8D0+LDN0/Wa9mRm4ixCYH2CyYYJNKaZt9+EZfNu+PPS4\n' +
      '8iB0TWH0DgQkbWMBfCRgolLLitAZklZ4dvdlEBS7evN1/7ttBxUK6SvkeeSx3zBl\n' +
      'ww3BlXqc3bvTQL0A+RRysaVyFbvtp9domFaDKZCpMmDFAN/ntx215xmQdrSt+K3F\n' +
      'cXdGQYHx5q410CAclGnbAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBT6iVWnm/uakS+tEX2mzIfw+8JL0zAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOCAQEA\n' +
      'FmDD+QuDklXn2EgShwQxV13+txPRuVdOSrutHhoCgMwFWCMtPPtBAKs6KPY7Guvw\n' +
      'DpJoZSehDiOfsgMirjOWjvfkeWSNvKfjWTVneX7pZD9W5WPnsDBvTbCGezm+v87z\n' +
      'b+ZM2ZMo98m/wkMcIEAgdSKilR2fuw8rLkAjhYFfs0A7tDgZ9noKwgHvoE4dsrI0\n' +
      'KZYco6DlP/brASfHTPa2puBLN9McK3v+h0JaSqqm5Ro2Bh56tZkQh8AWy/miuDuK\n' +
      '3+hNEVdxosxlkM1TPa1DGj0EzzK0yoeerXuH2HX7LlCrrxf6/wdKnjR12PMrLQ4A\n' +
      'pCqkcWw894z6bV9MAvKe6A==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBQzANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMTU0MDRaFw0y\n' +
      'MDAzMDUyMTU0MDRaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyB1cy1lYXN0LTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDI\n' +
      'UIuwh8NusKHk1SqPXcP7OqxY3S/M2ZyQWD3w7Bfihpyyy/fc1w0/suIpX3kbMhAV\n' +
      '2ESwged2/2zSx4pVnjp/493r4luhSqQYzru78TuPt9bhJIJ51WXunZW2SWkisSaf\n' +
      'USYUzVN9ezR/bjXTumSUQaLIouJt3OHLX49s+3NAbUyOI8EdvgBQWD68H1epsC0n\n' +
      'CI5s+pIktyOZ59c4DCDLQcXErQ+tNbDC++oct1ANd/q8p9URonYwGCGOBy7sbCYq\n' +
      '9eVHh1Iy2M+SNXddVOGw5EuruvHoCIQyOz5Lz4zSuZA9dRbrfztNOpezCNYu6NKM\n' +
      'n+hzcvdiyxv77uNm8EaxAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBQSQG3TmMe6Sa3KufaPBa72v4QFDzAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOCAQEA\n' +
      'L/mOZfB3187xTmjOHMqN2G2oSKHBKiQLM9uv8+97qT+XR+TVsBT6b3yoPpMAGhHA\n' +
      'Pc7nxAF5gPpuzatx0OTLPcmYucFmfqT/1qA5WlgCnMNtczyNMH97lKFTNV7Njtek\n' +
      'jWEzAEQSyEWrkNpNlC4j6kMYyPzVXQeXUeZTgJ9FNnVZqmvfjip2N22tawMjrCn5\n' +
      '7KN/zN65EwY2oO9XsaTwwWmBu3NrDdMbzJnbxoWcFWj4RBwanR1XjQOVNhDwmCOl\n' +
      '/1Et13b8CPyj69PC8BOVU6cfTSx8WUVy0qvYOKHNY9Bqa5BDnIL3IVmUkeTlM1mt\n' +
      'enRpyBj+Bk9rh/ICdiRKmA==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBSjANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzNDVaFw0y\n' +
      'MDAzMDUyMjAzNDVaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyB1cy13ZXN0LTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDE\n' +
      'Dhw+uw/ycaiIhhyu2pXFRimq0DlB8cNtIe8hdqndH8TV/TFrljNgR8QdzOgZtZ9C\n' +
      'zzQ2GRpInN/qJF6slEd6wO+6TaDBQkPY+07TXNt52POFUhdVkhJXHpE2BS7Xn6J7\n' +
      '7RFAOeG1IZmc2DDt+sR1BgXzUqHslQGfFYNS0/MBO4P+ya6W7IhruB1qfa4HiYQS\n' +
      'dbe4MvGWnv0UzwAqdR7OF8+8/5c58YXZIXCO9riYF2ql6KNSL5cyDPcYK5VK0+Q9\n' +
      'VI6vuJHSMYcF7wLePw8jtBktqAFE/wbdZiIHhZvNyiNWPPNTGUmQbaJ+TzQEHDs5\n' +
      '8en+/W7JKnPyBOkxxENbAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBS0nw/tFR9bCjgqWTPJkyy4oOD8bzAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOCAQEA\n' +
      'CXGAY3feAak6lHdqj6+YWjy6yyUnLK37bRxZDsyDVXrPRQaXRzPTzx79jvDwEb/H\n' +
      'Q/bdQ7zQRWqJcbivQlwhuPJ4kWPUZgSt3JUUuqkMsDzsvj/bwIjlrEFDOdHGh0mi\n' +
      'eVIngFEjUXjMh+5aHPEF9BlQnB8LfVtKj18e15UDTXFa+xJPFxUR7wDzCfo4WI1m\n' +
      'sUMG4q1FkGAZgsoyFPZfF8IVvgCuGdR8z30VWKklFxttlK0eGLlPAyIO0CQxPQlo\n' +
      'saNJrHf4tLOgZIWk+LpDhNd9Et5EzvJ3aURUsKY4pISPPF5WdvM9OE59bERwUErd\n' +
      'nuOuQWQeeadMceZnauRzJQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBSzANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTAyMDUyMjAzNTBaFw0y\n' +
      'MDAzMDUyMjAzNTBaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyB1cy13ZXN0LTIgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDM\n' +
      'H58SR48U6jyERC1vYTnub34smf5EQVXyzaTmspWGWGzT31NLNZGSDFaa7yef9kdO\n' +
      'mzJsgebR5tXq6LdwlIoWkKYQ7ycUaadtVKVYdI40QcI3cHn0qLFlg2iBXmWp/B+i\n' +
      'Z34VuVlCh31Uj5WmhaBoz8t/GRqh1V/aCsf3Wc6jCezH3QfuCjBpzxdOOHN6Ie2v\n' +
      'xX09O5qmZTvMoRBAvPkxdaPg/Mi7fxueWTbEVk78kuFbF1jHYw8U1BLILIAhcqlq\n' +
      'x4u8nl73t3O3l/soNUcIwUDK0/S+Kfqhwn9yQyPlhb4Wy3pfnZLJdkyHldktnQav\n' +
      '9TB9u7KH5Lk0aAYslMLxAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBT8roM4lRnlFHWMPWRz0zkwFZog1jAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQUFAAOCAQEA\n' +
      'JwrxwgwmPtcdaU7O7WDdYa4hprpOMamI49NDzmE0s10oGrqmLwZygcWU0jT+fJ+Y\n' +
      'pJe1w0CVfKaeLYNsOBVW3X4ZPmffYfWBheZiaiEflq/P6t7/Eg81gaKYnZ/x1Dfa\n' +
      'sUYkzPvCkXe9wEz5zdUTOCptDt89rBR9CstL9vE7WYUgiVVmBJffWbHQLtfjv6OF\n' +
      'NMb0QME981kGRzc2WhgP71YS2hHd1kXtsoYP1yTu4vThSKsoN4bkiHsaC1cRkLoy\n' +
      '0fFA4wpB3WloMEvCDaUvvH1LZlBXTNlwi9KtcwD4tDxkkBt4tQczKLGpQ/nF/W9n\n' +
      '8YDWk3IIc1sd0bkZqoau2Q==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEATCCAumgAwIBAgIBTDANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNTExMDYwMDA1NDZaFw0y\n' +
      'MDAzMDUwMDA1NDZaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJE\n' +
      'UyBhcC1ub3J0aGVhc3QtMiBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\n' +
      'ggEBAKSwd+RVUzTRH0FgnbwoTK8TMm/zMT4+2BvALpAUe6YXbkisg2goycWuuWLg\n' +
      'jOpFBB3GtyvXZnkqi7MkDWUmj1a2kf8l2oLyoaZ+Hm9x/sV+IJzOqPvj1XVUGjP6\n' +
      'yYYnPJmUYqvZeI7fEkIGdFkP2m4/sgsSGsFvpD9FK1bL1Kx2UDpYX0kHTtr18Zm/\n' +
      '1oN6irqWALSmXMDydb8hE0FB2A1VFyeKE6PnoDj/Y5cPHwPPdEi6/3gkDkSaOG30\n' +
      'rWeQfL3pOcKqzbHaWTxMphd0DSL/quZ64Nr+Ly65Q5PRcTrtr55ekOUziuqXwk+o\n' +
      '9QpACMwcJ7ROqOznZTqTzSFVXFECAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEGMBIG\n' +
      'A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFM6Nox/QWbhzWVvzoJ/y0kGpNPK+\n' +
      'MB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEBBQUA\n' +
      'A4IBAQCTkWBqNvyRf3Y/W21DwFx3oT/AIWrHt0BdGZO34tavummXemTH9LZ/mqv9\n' +
      'aljt6ZuDtf5DEQjdsAwXMsyo03ffnP7doWm8iaF1+Mui77ot0TmTsP/deyGwukvJ\n' +
      'tkxX8bZjDh+EaNauWKr+CYnniNxCQLfFtXYJsfOdVBzK3xNL+Z3ucOQRhr2helWc\n' +
      'CDQgwfhP1+3pRVKqHvWCPC4R3fT7RZHuRmZ38kndv476GxRntejh+ePffif78bFI\n' +
      '3rIZCPBGobrrUMycafSbyXteoGca/kA+/IqrAPlk0pWQ4aEL0yTWN2h2dnjoD7oX\n' +
      'byIuL/g9AGRh97+ssn7D6bDRPTbW\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/TCCAuWgAwIBAgIBTTANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNjA1MDMyMTI5MjJaFw0y\n' +
      'MDAzMDUyMTI5MjJaMIGQMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEhMB8GA1UEAwwYQW1hem9uIFJE\n' +
      'UyBhcC1zb3V0aC0xIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n' +
      '06eWGLE0TeqL9kyWOLkS8q0fXO97z+xyBV3DKSB2lg2GkgBz3B98MkmkeB0SZy3G\n' +
      'Ce4uCpCPbFKiFEdiUclOlhZsrBuCeaimxLM3Ig2wuenElO/7TqgaYHYUbT3d+VQW\n' +
      'GUbLn5GRZJZe1OAClYdOWm7A1CKpuo+cVV1vxbY2nGUQSJPpVn2sT9gnwvjdE60U\n' +
      'JGYU/RLCTm8zmZBvlWaNIeKDnreIc4rKn6gUnJ2cQn1ryCVleEeyc3xjYDSrjgdn\n' +
      'FLYGcp9mphqVT0byeQMOk0c7RHpxrCSA0V5V6/CreFV2LteK50qcDQzDSM18vWP/\n' +
      'p09FoN8O7QrtOeZJzH/lmwIDAQABo2YwZDAOBgNVHQ8BAf8EBAMCAQYwEgYDVR0T\n' +
      'AQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU2i83QHuEl/d0keXF+69HNJph7cMwHwYD\n' +
      'VR0jBBgwFoAUTgLurD72FchM7Sz1BcGPnIQISYMwDQYJKoZIhvcNAQELBQADggEB\n' +
      'ACqnH2VjApoDqoSQOky52QBwsGaj+xWYHW5Gm7EvCqvQuhWMkeBuD6YJmMvNyA9G\n' +
      'I2lh6/o+sUk/RIsbYbxPRdhNPTOgDR9zsNRw6qxaHztq/CEC+mxDCLa3O1hHBaDV\n' +
      'BmB3nCZb93BvO0EQSEk7aytKq/f+sjyxqOcs385gintdHGU9uM7gTZHnU9vByJsm\n' +
      '/TL07Miq67X0NlhIoo3jAk+xHaeKJdxdKATQp0448P5cY20q4b8aMk1twcNaMvCP\n' +
      'dG4M5doaoUA8OQ/0ukLLae/LBxLeTw04q1/a2SyFaVUX2Twbb1S3xVWwLA8vsyGr\n' +
      'igXx7B5GgP+IHb6DTjPJAi0=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBTjANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNjA4MTExOTU4NDVaFw0y\n' +
      'MDAzMDUxOTU4NDVaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyB1cy1lYXN0LTIgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCp\n' +
      'WnnUX7wM0zzstccX+4iXKJa9GR0a2PpvB1paEX4QRCgfhEdQWDaSqyrWNgdVCKkt\n' +
      '1aQkWu5j6VAC2XIG7kKoonm1ZdBVyBLqW5lXNywlaiU9yhJkwo8BR+/OqgE+PLt/\n' +
      'EO1mlN0PQudja/XkExCXTO29TG2j7F/O7hox6vTyHNHc0H88zS21uPuBE+jivViS\n' +
      'yzj/BkyoQ85hnkues3f9R6gCGdc+J51JbZnmgzUkvXjAEuKhAm9JksVOxcOKUYe5\n' +
      'ERhn0U9zjzpfbAITIkul97VVa5IxskFFTHIPJbvRKHJkiF6wTJww/tc9wm+fSCJ1\n' +
      '+DbQTGZgkQ3bJrqRN29/AgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBSAHQzUYYZbepwKEMvGdHp8wzHnfDAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQsFAAOCAQEA\n' +
      'MbaEzSYZ+aZeTBxf8yi0ta8K4RdwEJsEmP6IhFFQHYUtva2Cynl4Q9tZg3RMsybT\n' +
      '9mlnSQQlbN/wqIIXbkrcgFcHoXG9Odm/bDtUwwwDaiEhXVfeQom3G77QHOWMTCGK\n' +
      'qadwuh5msrb17JdXZoXr4PYHDKP7j0ONfAyFNER2+uecblHfRSpVq5UeF3L6ZJb8\n' +
      'fSw/GtAV6an+/0r+Qm+PiI2H5XuZ4GmRJYnGMhqWhBYrY7p3jtVnKcsh39wgfUnW\n' +
      'AvZEZG/yhFyAZW0Essa39LiL5VSq14Y1DOj0wgnhSY/9WHxaAo1HB1T9OeZknYbD\n' +
      'fl/EGSZ0TEvZkENrXcPlVA==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/zCCAuegAwIBAgIBTzANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNjA5MTUwMDEwMTFaFw0y\n' +
      'MDAzMDUwMDEwMTFaMIGSMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEjMCEGA1UEAwwaQW1hem9uIFJE\n' +
      'UyBjYS1jZW50cmFsLTEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIB\n' +
      'AQCZYI/iQ6DrS3ny3t1EwX1wAD+3LMgh7Fd01EW5LIuaK2kYIIQpsVKhxLCit/V5\n' +
      'AGc/1qiJS1Qz9ODLTh0Na6bZW6EakRzuHJLe32KJtoFYPC7Z09UqzXrpA/XL+1hM\n' +
      'P0ZmCWsU7Nn/EmvfBp9zX3dZp6P6ATrvDuYaVFr+SA7aT3FXpBroqBS1fyzUPs+W\n' +
      'c6zTR6+yc4zkHX0XQxC5RH6xjgpeRkoOajA/sNo7AQF7KlWmKHbdVF44cvvAhRKZ\n' +
      'XaoVs/C4GjkaAEPTCbopYdhzg+KLx9eB2BQnYLRrIOQZtRfbQI2Nbj7p3VsRuOW1\n' +
      'tlcks2w1Gb0YC6w6SuIMFkl1AgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNV\n' +
      'HRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBToYWxE1lawl6Ks6NsvpbHQ3GKEtzAf\n' +
      'BgNVHSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQsFAAOC\n' +
      'AQEAG/8tQ0ooi3hoQpa5EJz0/E5VYBsAz3YxA2HoIonn0jJyG16bzB4yZt4vNQMA\n' +
      'KsNlQ1uwDWYL1nz63axieUUFIxqxl1KmwfhsmLgZ0Hd2mnTPIl2Hw3uj5+wdgGBg\n' +
      'agnAZ0bajsBYgD2VGQbqjdk2Qn7Fjy3LEWIvGZx4KyZ99OJ2QxB7JOPdauURAtWA\n' +
      'DKYkP4LLJxtj07DSzG8kuRWb9B47uqUD+eKDIyjfjbnzGtd9HqqzYFau7EX3HVD9\n' +
      '9Qhnjl7bTZ6YfAEZ3nH2t3Vc0z76XfGh47rd0pNRhMV+xpok75asKf/lNh5mcUrr\n' +
      'VKwflyMkQpSbDCmcdJ90N2xEXQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBUDANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNjEwMTAxNzQ0NDJaFw0y\n' +
      'MDAzMDUxNzQ0NDJaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyBldS13ZXN0LTIgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDO\n' +
      'cttLJfubB4XMMIGWNfJISkIdCMGJyOzLiMJaiWB5GYoXKhEl7YGotpy0qklwW3BQ\n' +
      'a0fmVdcCLX+dIuVQ9iFK+ZcK7zwm7HtdDTCHOCKeOh2IcnU4c/VIokFi6Gn8udM6\n' +
      'N/Zi5M5OGpVwLVALQU7Yctsn3c95el6MdVx6mJiIPVu7tCVZn88Z2koBQ2gq9P4O\n' +
      'Sb249SHFqOb03lYDsaqy1NDsznEOhaRBw7DPJFpvmw1lA3/Y6qrExRI06H2VYR2i\n' +
      '7qxwDV50N58fs10n7Ye1IOxTVJsgEA7X6EkRRXqYaM39Z76R894548WHfwXWjUsi\n' +
      'MEX0RS0/t1GmnUQjvevDAgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBQBxmcuRSxERYCtNnSr5xNfySokHjAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQsFAAOCAQEA\n' +
      'UyCUQjsF3nUAABjfEZmpksTuUo07aT3KGYt+EMMFdejnBQ0+2lJJFGtT+CDAk1SD\n' +
      'RSgfEBon5vvKEtlnTf9a3pv8WXOAkhfxnryr9FH6NiB8obISHNQNPHn0ljT2/T+I\n' +
      'Y6ytfRvKHa0cu3V0NXbJm2B4KEOt4QCDiFxUIX9z6eB4Kditwu05OgQh6KcogOiP\n' +
      'JesWxBMXXGoDC1rIYTFO7szwDyOHlCcVXJDNsTJhc32oDWYdeIbW7o/5I+aQsrXZ\n' +
      'C96HykZcgWzz6sElrQxUaT3IoMw/5nmw4uWKKnZnxgI9bY4fpQwMeBZ96iHfFxvH\n' +
      'mqfEEuC7uUoPofXdBp2ObQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/DCCAuSgAwIBAgIBUTANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNzA4MjUyMTM5MjZaFw0y\n' +
      'MDAzMDUyMTM5MjZaMIGPMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJE\n' +
      'UyBldS13ZXN0LTMgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC+\n' +
      'xmlEC/3a4cJH+UPwXCE02lC7Zq5NHd0dn6peMeLN8agb6jW4VfSY0NydjRj2DJZ8\n' +
      'K7wV6sub5NUGT1NuFmvSmdbNR2T59KX0p2dVvxmXHHtIpQ9Y8Aq3ZfhmC5q5Bqgw\n' +
      'tMA1xayDi7HmoPX3R8kk9ktAZQf6lDeksCvok8idjTu9tiSpDiMwds5BjMsWfyjZ\n' +
      'd13PTGGNHYVdP692BSyXzSP1Vj84nJKnciW8tAqwIiadreJt5oXyrCXi8ekUMs80\n' +
      'cUTuGm3aA3Q7PB5ljJMPqz0eVddaiIvmTJ9O3Ez3Du/HpImyMzXjkFaf+oNXf/Hx\n' +
      '/EW5jCRR6vEiXJcDRDS7AgMBAAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMB\n' +
      'Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBRZ9mRtS5fHk3ZKhG20Oack4cAqMTAfBgNV\n' +
      'HSMEGDAWgBROAu6sPvYVyEztLPUFwY+chAhJgzANBgkqhkiG9w0BAQsFAAOCAQEA\n' +
      'F/u/9L6ExQwD73F/bhCw7PWcwwqsK1mypIdrjdIsu0JSgwWwGCXmrIspA3n3Dqxq\n' +
      'sMhAJD88s9Em7337t+naar2VyLO63MGwjj+vA4mtvQRKq8ScIpiEc7xN6g8HUMsd\n' +
      'gPG9lBGfNjuAZsrGJflrko4HyuSM7zHExMjXLH+CXcv/m3lWOZwnIvlVMa4x0Tz0\n' +
      'A4fklaawryngzeEjuW6zOiYCzjZtPlP8Fw0SpzppJ8VpQfrZ751RDo4yudmPqoPK\n' +
      '5EUe36L8U+oYBXnC5TlYs9bpVv9o5wJQI5qA9oQE2eFWxF1E0AyZ4V5sgGUBStaX\n' +
      'BjDDWul0wSo7rt1Tq7XpnA==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEATCCAumgAwIBAgIBTjANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNzEyMDEwMDU1NDJaFw0y\n' +
      'MDAzMDUwMDU1NDJaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJE\n' +
      'UyBhcC1ub3J0aGVhc3QtMyBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\n' +
      'ggEBAMZtQNnm/XT19mTa10ftHLzg5UhajoI65JHv4TQNdGXdsv+CQdGYU49BJ9Eu\n' +
      '3bYgiEtTzR2lQe9zGMvtuJobLhOWuavzp7IixoIQcHkFHN6wJ1CvqrxgvJfBq6Hy\n' +
      'EuCDCiU+PPDLUNA6XM6Qx3IpHd1wrJkjRB80dhmMSpxmRmx849uFafhN+P1QybsM\n' +
      'TI0o48VON2+vj+mNuQTyLMMP8D4odSQHjaoG+zyJfJGZeAyqQyoOUOFEyQaHC3TT\n' +
      '3IDSNCQlpxb9LerbCoKu79WFBBq3CS5cYpg8/fsnV2CniRBFFUumBt5z4dhw9RJU\n' +
      'qlUXXO1ZyzpGd+c5v6FtrfXtnIUCAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEGMBIG\n' +
      'A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFETv7ELNplYy/xTeIOInl6nzeiHg\n' +
      'MB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEBBQUA\n' +
      'A4IBAQCpKxOQcd0tEKb3OtsOY8q/MPwTyustGk2Rt7t9G68idADp8IytB7M0SDRo\n' +
      'wWZqynEq7orQVKdVOanhEWksNDzGp0+FPAf/KpVvdYCd7ru3+iI+V4ZEp2JFdjuZ\n' +
      'Zz0PIjS6AgsZqE5Ri1J+NmfmjGZCPhsHnGZiBaenX6K5VRwwwmLN6xtoqrrfR5zL\n' +
      'QfBeeZNJG6KiM3R/DxJ5rAa6Fz+acrhJ60L7HprhB7SFtj1RCijau3+ZwiGmUOMr\n' +
      'yKlMv+VgmzSw7o4Hbxy1WVrA6zQsTHHSGf+vkQn2PHvnFMUEu/ZLbTDYFNmTLK91\n' +
      'K6o4nMsEvhBKgo4z7H1EqqxXhvN2\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBDCCAuygAwIBAgIBTTANBgkqhkiG9w0BAQUFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xNzEyMDYyMjQyMjdaFw0y\n' +
      'MDAzMDQyMjQyMjdaMIGXMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEoMCYGA1UEAwwfQW1hem9uIFJE\n' +
      'UyBwcmV2aWV3LXVzLWVhc3QtMiBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC\n' +
      'AQoCggEBAMw0E8k8URanS0c/i1S7wzFf5+XC9H2bm+4pENdElGP5s9rVCybrzJaw\n' +
      '6zZgVLpOFnS9mJ+sDHIMUexPjj0X4+r7wZ4+hPfy7Rmrgbt23IQwr+PIBxsKAVjj\n' +
      'iaQ3bSm5WQ79an5elfQqEDdZ13ckUcLBJDA8bUDthI8m7gnteGtx0M1D0VS5PDs9\n' +
      'cf96QlBia9Lx3VcNo3cc0PzP30E4j3h/Ywlb0jXUgB6oVlTxK70BjD3kZa+2xlea\n' +
      'vKmm4NqGVhPY7BWd4XNdbSYsPDeZ9HxHNWXZxoHcQ7vSU8RKYVPtoBK/zIp3eWOi\n' +
      'gzZlm5vYPvlkYh2pshttPPVyhZqlEZ8CAwEAAaNmMGQwDgYDVR0PAQH/BAQDAgEG\n' +
      'MBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFI93K+FRhste6w3MiD+IK3Tc\n' +
      'g/BsMB8GA1UdIwQYMBaAFE4C7qw+9hXITO0s9QXBj5yECEmDMA0GCSqGSIb3DQEB\n' +
      'BQUAA4IBAQAs4RsC8MJVOvrlRi5sgKC9LJ4BvSrrbR5V8CdIEwlPqrVOSsU5t7Py\n' +
      'j8CHoPUY/ya1azlBSO62BqdZxipFuAR06NdxNG2Gy0fGl71N2udxokwEPW+IEZ81\n' +
      'G6JeX8HNFjnna8ehimz1VJDDW7qborhg3dCAgEWkgv5PDR9/zoUu6bbmHPV77zbx\n' +
      'Gq7Sybz5OiagC7Nj9N1WgjNXUEmlfY2DHXnJmIVgUGEVrBgu5tGcIU/bQCRznH1N\n' +
      'JsBH0SalneCbSzMBhQdnzL+L5KOERibWAZvS6ebmomTBwa03kgo/T0DfEccgobTs\n' +
      'rV6T9/8Vg9T18vEeqURL+LOGs7+lIKmN\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIID/TCCAuWgAwIBAgIBUjANBgkqhkiG9w0BAQsFADCBijELMAkGA1UEBhMCVVMx\n' +
      'EzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'GzAZBgNVBAMMEkFtYXpvbiBSRFMgUm9vdCBDQTAeFw0xODA5MjgxNzM0NTJaFw0y\n' +
      'MDAzMDUxNzM0NTJaMIGQMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2FzaGluZ3Rv\n' +
      'bjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNl\n' +
      'cywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEhMB8GA1UEAwwYQW1hem9uIFJE\n' +
      'UyBldS1ub3J0aC0xIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n' +
      'wvHfpoixHNy1jvcq/WNhXDHlsFVbEOX7mp01YQeK0wWqlpFvjs2HFJ1sRnnmyhdT\n' +
      'sv4VQuXnQw2V2iFAO2HveDi8pcJ+eIXY+wloSVBytgYLTMcNpn5LmqIeyGO+Lr6p\n' +
      'KUr78I4uE0mnabxyILA96CYrYtgwpLCtpEXSdSJPwOSK9nX9++molxLcJ5v4fiPS\n' +
      'j46PETsbFoFdXXwYCdiJKpzO4zUAkKzzvzbF7cXg9R4noJuytjEKbluxugDHdnwl\n' +
      'SctGZ3moju2I0OpPbJKUI3wHsUMtY5v15X74MOED5lbtaW5+/6JIERggve0b23Ni\n' +
      '4nlYSt0Bb3z3Zwc83twCUwIDAQABo2YwZDAOBgNVHQ8BAf8EBAMCAQYwEgYDVR0T\n' +
      'AQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU4stOy1OAFRyvZCSKNfCiPRD+rPowHwYD\n' +
      'VR0jBBgwFoAUTgLurD72FchM7Sz1BcGPnIQISYMwDQYJKoZIhvcNAQELBQADggEB\n' +
      'AHpRIlKh1fqbMHl0+VnJ/52XQy1F5gM2hnw3lYkOLsDyzj9W4V6D1v2EDgYW+ZVH\n' +
      '0wWqo8m0jS6CDn14W2HqNlyXyHpJK3eh3088zxvJgKqzKS4ghNzafN7axwYIwRN6\n' +
      '9rrhRWy9MaFHaSPKtgiuTxw9fOekqyJdO+OYpBVEp7KEEyEG9/W5xZcU64zGb6UT\n' +
      '8/g4+5t+HlT0nYBMvt8HW7w2XbFBetfKKK4WaoPKloOMN+RLO/JgJ6pVWvxM8nhC\n' +
      'PbVtr43OI1sQAXYk0an7aUDgXT98vGwovWNHI6lFCMGRG+WXhauLtKRsIr4hR1LV\n' +
      'fES7Q9MWPzPYHQoKELF9Jhk=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwgZQxCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSUwIwYDVQQDDBxBbWF6b24gUkRTIGFwLWVhc3QtMSBSb290IENBMB4XDTE5MDIx\n' +
      'NzAyNDcwMFoXDTIyMDYwMTEyMDAwMFowgY8xCzAJBgNVBAYTAlVTMRMwEQYDVQQI\n' +
      'DApXYXNoaW5ndG9uMRAwDgYDVQQHDAdTZWF0dGxlMSIwIAYDVQQKDBlBbWF6b24g\n' +
      'V2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMSAwHgYDVQQD\n' +
      'DBdBbWF6b24gUkRTIGFwLWVhc3QtMSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBAOcJAUofyJuBuPr5ISHi/Ha5ed8h3eGdzn4MBp6rytPOg9NVGRQs\n' +
      'O93fNGCIKsUT6gPuk+1f1ncMTV8Y0Fdf4aqGWme+Khm3ZOP3V1IiGnVq0U2xiOmn\n' +
      'SQ4Q7LoeQC4lC6zpoCHVJyDjZ4pAknQQfsXb77Togdt/tK5ahev0D+Q3gCwAoBoO\n' +
      'DHKJ6t820qPi63AeGbJrsfNjLKiXlFPDUj4BGir4dUzjEeH7/hx37na1XG/3EcxP\n' +
      '399cT5k7sY/CR9kctMlUyEEUNQOmhi/ly1Lgtihm3QfjL6K9aGLFNwX35Bkh9aL2\n' +
      'F058u+n8DP/dPeKUAcJKiQZUmzuen5n57x8CAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFFlqgF4FQlb9yP6c+Q3E\n' +
      'O3tXv+zOMB8GA1UdIwQYMBaAFK9T6sY/PBZVbnHcNcQXf58P4OuPMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQDeXiS3v1z4jWAo1UvVyKDeHjtrtEH1Rida1eOXauFuEQa5tuOk\n' +
      'E53Os4haZCW4mOlKjigWs4LN+uLIAe1aFXGo92nGIqyJISHJ1L+bopx/JmIbHMCZ\n' +
      '0lTNJfR12yBma5VQy7vzeFku/SisKwX0Lov1oHD4MVhJoHbUJYkmAjxorcIHORvh\n' +
      'I3Vj5XrgDWtLDPL8/Id/roul/L+WX5ir+PGScKBfQIIN2lWdZoqdsx8YWqhm/ikL\n' +
      'C6qNieSwcvWL7C03ri0DefTQMY54r5wP33QU5hJ71JoaZI3YTeT0Nf+NRL4hM++w\n' +
      'Q0veeNzBQXg1f/JxfeA39IDIX1kiCf71tGlT\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEEDCCAvigAwIBAgIJAJF3HxEqKM4lMA0GCSqGSIb3DQEBCwUAMIGUMQswCQYD\n' +
      'VQQGEwJVUzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEi\n' +
      'MCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1h\n' +
      'em9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJEUyBhcC1lYXN0LTEgUm9vdCBDQTAe\n' +
      'Fw0xOTAyMTcwMjQ2MTFaFw0yNDAyMTYwMjQ2MTFaMIGUMQswCQYDVQQGEwJVUzEQ\n' +
      'MA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEiMCAGA1UECgwZ\n' +
      'QW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEl\n' +
      'MCMGA1UEAwwcQW1hem9uIFJEUyBhcC1lYXN0LTEgUm9vdCBDQTCCASIwDQYJKoZI\n' +
      'hvcNAQEBBQADggEPADCCAQoCggEBAOCVr1Yj5IW4XWa9QOLGJDSz4pqIM6BAbqQp\n' +
      'gYvzIO4Lv8c8dEnuuuCY8M/zOrJ1iQJ3cDiKGa32HVBVcH+nUdXzw4Jq5jw0hsb6\n' +
      '/WW2RD2aUe4jCkRD5wNzmeHM4gTgtMZnXNVHpELgKR4wVhSHEfWFTiMsZi35y8mj\n' +
      'PL98Mz/m/nMnB/59EjMvcJMrsUljHO6B9BMEcvNkwvre9xza0BQWKyiVRcbOpoj1\n' +
      'w4BPtYYZ+dW2QKw9AmYXwAmCLeATsxrHIJ/IbzS7obxv2QN2Eh4pJ3ghRCFv1XM9\n' +
      'XVkm13oiCjj7jsxAwF7o+VggPl/GG+/Gwk+TLuaTFNAtROpPxL8CAwEAAaNjMGEw\n' +
      'DgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFK9T6sY/\n' +
      'PBZVbnHcNcQXf58P4OuPMB8GA1UdIwQYMBaAFK9T6sY/PBZVbnHcNcQXf58P4OuP\n' +
      'MA0GCSqGSIb3DQEBCwUAA4IBAQBBY+KATaT7ndYT3Ky0VWaiwNfyl1u3aDxr+MKP\n' +
      'VeDhtOhlob5u0E+edOXUvEXd4A+ntS+U0HmwvtMXtQbQ2EJbsNRqZnS8KG9YB2Yc\n' +
      'Q99auphW3wMjwHRtflLO5h14aa9SspqJJgcM1R7Z3pAYeq6bpBDxZSGrYtWI64q4\n' +
      'h4i67qWAGDFcXSTW1kJ00GMlBCIGTeYiu8LYutdsDWzYKkeezJRjx9VR4w7A7e1G\n' +
      'WmY4aUg/8aPxCioY2zEQKNl55Ghg6Dwy+6BxaV6RlV9r9EaSCai11p1bgS568WQn\n' +
      '4WNQK36EGe37l2SOpDB6STrq57/rjREvmq803Ylg/Gf6qqzK\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECTCCAvGgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwgZUxCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSYwJAYDVQQDDB1BbWF6b24gUkRTIG1lLXNvdXRoLTEgUm9vdCBDQTAeFw0xOTA1\n' +
      'MTAyMTU4NDNaFw0yNTA2MDExMjAwMDBaMIGQMQswCQYDVQQGEwJVUzETMBEGA1UE\n' +
      'CAwKV2FzaGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9u\n' +
      'IFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEhMB8GA1UE\n' +
      'AwwYQW1hem9uIFJEUyBtZS1zb3V0aC0xIENBMIIBIjANBgkqhkiG9w0BAQEFAAOC\n' +
      'AQ8AMIIBCgKCAQEAudOYPZH+ihJAo6hNYMB5izPVBe3TYhnZm8+X3IoaaYiKtsp1\n' +
      'JJhkTT0CEejYIQ58Fh4QrMUyWvU8qsdK3diNyQRoYLbctsBPgxBR1u07eUJDv38/\n' +
      'C1JlqgHmMnMi4y68Iy7ymv50QgAMuaBqgEBRI1R6Lfbyrb2YvH5txjJyTVMwuCfd\n' +
      'YPAtZVouRz0JxmnfsHyxjE+So56uOKTDuw++Ho4HhZ7Qveej7XB8b+PIPuroknd3\n' +
      'FQB5RVbXRvt5ZcVD4F2fbEdBniF7FAF4dEiofVCQGQ2nynT7dZdEIPfPdH3n7ZmE\n' +
      'lAOmwHQ6G83OsiHRBLnbp+QZRgOsjkHJxT20bQIDAQABo2YwZDAOBgNVHQ8BAf8E\n' +
      'BAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUOEVDM7VomRH4HVdA\n' +
      'QvIMNq2tXOcwHwYDVR0jBBgwFoAU54cfDjgwBx4ycBH8+/r8WXdaiqYwDQYJKoZI\n' +
      'hvcNAQELBQADggEBAHhvMssj+Th8IpNePU6RH0BiL6o9c437R3Q4IEJeFdYL+nZz\n' +
      'PW/rELDPvLRUNMfKM+KzduLZ+l29HahxefejYPXtvXBlq/E/9czFDD4fWXg+zVou\n' +
      'uDXhyrV4kNmP4S0eqsAP/jQHPOZAMFA4yVwO9hlqmePhyDnszCh9c1PfJSBh49+b\n' +
      '4w7i/L3VBOMt8j3EKYvqz0gVfpeqhJwL4Hey8UbVfJRFJMJzfNHpePqtDRAY7yjV\n' +
      'PYquRaV2ab/E+/7VFkWMM4tazYz/qsYA2jSH+4xDHvYk8LnsbcrF9iuidQmEc5sb\n' +
      'FgcWaSKG4DJjcI5k7AJLWcXyTDt21Ci43LE+I9Q=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEEjCCAvqgAwIBAgIJANew34ehz5l8MA0GCSqGSIb3DQEBCwUAMIGVMQswCQYD\n' +
      'VQQGEwJVUzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEi\n' +
      'MCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1h\n' +
      'em9uIFJEUzEmMCQGA1UEAwwdQW1hem9uIFJEUyBtZS1zb3V0aC0xIFJvb3QgQ0Ew\n' +
      'HhcNMTkwNTEwMjE0ODI3WhcNMjQwNTA4MjE0ODI3WjCBlTELMAkGA1UEBhMCVVMx\n' +
      'EDAOBgNVBAcMB1NlYXR0bGUxEzARBgNVBAgMCldhc2hpbmd0b24xIjAgBgNVBAoM\n' +
      'GUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMx\n' +
      'JjAkBgNVBAMMHUFtYXpvbiBSRFMgbWUtc291dGgtMSBSb290IENBMIIBIjANBgkq\n' +
      'hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp7BYV88MukcY+rq0r79+C8UzkT30fEfT\n' +
      'aPXbx1d6M7uheGN4FMaoYmL+JE1NZPaMRIPTHhFtLSdPccInvenRDIatcXX+jgOk\n' +
      'UA6lnHQ98pwN0pfDUyz/Vph4jBR9LcVkBbe0zdoKKp+HGbMPRU0N2yNrog9gM5O8\n' +
      'gkU/3O2csJ/OFQNnj4c2NQloGMUpEmedwJMOyQQfcUyt9CvZDfIPNnheUS29jGSw\n' +
      'ERpJe/AENu8Pxyc72jaXQuD+FEi2Ck6lBkSlWYQFhTottAeGvVFNCzKszCntrtqd\n' +
      'rdYUwurYsLTXDHv9nW2hfDUQa0mhXf9gNDOBIVAZugR9NqNRNyYLHQIDAQABo2Mw\n' +
      'YTAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU54cf\n' +
      'DjgwBx4ycBH8+/r8WXdaiqYwHwYDVR0jBBgwFoAU54cfDjgwBx4ycBH8+/r8WXda\n' +
      'iqYwDQYJKoZIhvcNAQELBQADggEBAIIMTSPx/dR7jlcxggr+O6OyY49Rlap2laKA\n' +
      'eC/XI4ySP3vQkIFlP822U9Kh8a9s46eR0uiwV4AGLabcu0iKYfXjPkIprVCqeXV7\n' +
      'ny9oDtrbflyj7NcGdZLvuzSwgl9SYTJp7PVCZtZutsPYlbJrBPHwFABvAkMvRtDB\n' +
      'hitIg4AESDGPoCl94sYHpfDfjpUDMSrAMDUyO6DyBdZH5ryRMAs3lGtsmkkNUrso\n' +
      'aTW6R05681Z0mvkRdb+cdXtKOSuDZPoe2wJJIaz3IlNQNSrB5TImMYgmt6iAsFhv\n' +
      '3vfTSTKrZDNTJn4ybG6pq1zWExoXsktZPylJly6R3RBwV6nwqBM=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEETCCAvmgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwgZQxCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSUwIwYDVQQDDBxBbWF6b24gUkRTIEJldGEgUm9vdCAyMDE5IENBMB4XDTE5MDgy\n' +
      'MDE3MTAwN1oXDTI0MDgxOTE3MzgyNlowgZkxCzAJBgNVBAYTAlVTMRMwEQYDVQQI\n' +
      'DApXYXNoaW5ndG9uMRAwDgYDVQQHDAdTZWF0dGxlMSIwIAYDVQQKDBlBbWF6b24g\n' +
      'V2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMSowKAYDVQQD\n' +
      'DCFBbWF6b24gUkRTIEJldGEgdXMtZWFzdC0xIDIwMTkgQ0EwggEiMA0GCSqGSIb3\n' +
      'DQEBAQUAA4IBDwAwggEKAoIBAQDTNCOlotQcLP8TP82U2+nk0bExVuuMVOgFeVMx\n' +
      'vbUHZQeIj9ikjk+jm6eTDnnkhoZcmJiJgRy+5Jt69QcRbb3y3SAU7VoHgtraVbxF\n' +
      'QDh7JEHI9tqEEVOA5OvRrDRcyeEYBoTDgh76ROco2lR+/9uCvGtHVrMCtG7BP7ZB\n' +
      'sSVNAr1IIRZZqKLv2skKT/7mzZR2ivcw9UeBBTUf8xsfiYVBvMGoEsXEycjYdf6w\n' +
      'WV+7XS7teNOc9UgsFNN+9AhIBc1jvee5E//72/4F8pAttAg/+mmPUyIKtekNJ4gj\n' +
      'OAR2VAzGx1ybzWPwIgOudZFHXFduxvq4f1hIRPH0KbQ/gkRrAgMBAAGjZjBkMA4G\n' +
      'A1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBTkvpCD\n' +
      '6C43rar9TtJoXr7q8dkrrjAfBgNVHSMEGDAWgBStoQwVpbGx87fxB3dEGDqKKnBT\n' +
      '4TANBgkqhkiG9w0BAQsFAAOCAQEAJd9fOSkwB3uVdsS+puj6gCER8jqmhd3g/J5V\n' +
      'Zjk9cKS8H0e8pq/tMxeJ8kpurPAzUk5RkCspGt2l0BSwmf3ahr8aJRviMX6AuW3/\n' +
      'g8aKplTvq/WMNGKLXONa3Sq8591J+ce8gtOX/1rDKmFI4wQ/gUzOSYiT991m7QKS\n' +
      'Fr6HMgFuz7RNJbb3Fy5cnurh8eYWA7mMv7laiLwTNsaro5qsqErD5uXuot6o9beT\n' +
      'a+GiKinEur35tNxAr47ax4IRubuIzyfCrezjfKc5raVV2NURJDyKP0m0CCaffAxE\n' +
      'qn2dNfYc3v1D8ypg3XjHlOzRo32RB04o8ALHMD9LSwsYDLpMag==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEEDCCAvigAwIBAgIJAKFMXyltvuRdMA0GCSqGSIb3DQEBCwUAMIGUMQswCQYD\n' +
      'VQQGEwJVUzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEi\n' +
      'MCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1h\n' +
      'em9uIFJEUzElMCMGA1UEAwwcQW1hem9uIFJEUyBCZXRhIFJvb3QgMjAxOSBDQTAe\n' +
      'Fw0xOTA4MTkxNzM4MjZaFw0yNDA4MTkxNzM4MjZaMIGUMQswCQYDVQQGEwJVUzEQ\n' +
      'MA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEiMCAGA1UECgwZ\n' +
      'QW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEl\n' +
      'MCMGA1UEAwwcQW1hem9uIFJEUyBCZXRhIFJvb3QgMjAxOSBDQTCCASIwDQYJKoZI\n' +
      'hvcNAQEBBQADggEPADCCAQoCggEBAMkZdnIH9ndatGAcFo+DppGJ1HUt4x+zeO+0\n' +
      'ZZ29m0sfGetVulmTlv2d5b66e+QXZFWpcPQMouSxxYTW08TbrQiZngKr40JNXftA\n' +
      'atvzBqIImD4II0ZX5UEVj2h98qe/ypW5xaDN7fEa5e8FkYB1TEemPaWIbNXqchcL\n' +
      'tV7IJPr3Cd7Z5gZJlmujIVDPpMuSiNaal9/6nT9oqN+JSM1fx5SzrU5ssg1Vp1vv\n' +
      '5Xab64uOg7wCJRB9R2GC9XD04odX6VcxUAGrZo6LR64ZSifupo3l+R5sVOc5i8NH\n' +
      'skdboTzU9H7+oSdqoAyhIU717PcqeDum23DYlPE2nGBWckE+eT8CAwEAAaNjMGEw\n' +
      'DgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFK2hDBWl\n' +
      'sbHzt/EHd0QYOooqcFPhMB8GA1UdIwQYMBaAFK2hDBWlsbHzt/EHd0QYOooqcFPh\n' +
      'MA0GCSqGSIb3DQEBCwUAA4IBAQAO/718k8EnOqJDx6wweUscGTGL/QdKXUzTVRAx\n' +
      'JUsjNUv49mH2HQVEW7oxszfH6cPCaupNAddMhQc4C/af6GHX8HnqfPDk27/yBQI+\n' +
      'yBBvIanGgxv9c9wBbmcIaCEWJcsLp3HzXSYHmjiqkViXwCpYfkoV3Ns2m8bp+KCO\n' +
      'y9XmcCKRaXkt237qmoxoh2sGmBHk2UlQtOsMC0aUQ4d7teAJG0q6pbyZEiPyKZY1\n' +
      'XR/UVxMJL0Q4iVpcRS1kaNCMfqS2smbLJeNdsan8pkw1dvPhcaVTb7CvjhJtjztF\n' +
      'YfDzAI5794qMlWxwilKMmUvDlPPOTen8NNHkLwWvyFCH7Doh\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEFzCCAv+gAwIBAgICFSUwDQYJKoZIhvcNAQELBQAwgZcxCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSgwJgYDVQQDDB9BbWF6b24gUkRTIFByZXZpZXcgUm9vdCAyMDE5IENBMB4XDTE5\n' +
      'MDgyMTIyMzk0N1oXDTI0MDgyMTIyMjk0OVowgZwxCzAJBgNVBAYTAlVTMRMwEQYD\n' +
      'VQQIDApXYXNoaW5ndG9uMRAwDgYDVQQHDAdTZWF0dGxlMSIwIAYDVQQKDBlBbWF6\n' +
      'b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMS0wKwYD\n' +
      'VQQDDCRBbWF6b24gUkRTIFByZXZpZXcgdXMtZWFzdC0yIDIwMTkgQ0EwggEiMA0G\n' +
      'CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQD0dB/U7qRnSf05wOi7m10Pa2uPMTJv\n' +
      'r6U/3Y17a5prq5Zr4++CnSUYarG51YuIf355dKs+7Lpzs782PIwCmLpzAHKWzix6\n' +
      'pOaTQ+WZ0+vUMTxyqgqWbsBgSCyP7pVBiyqnmLC/L4az9XnscrbAX4pNaoJxsuQe\n' +
      'mzBo6yofjQaAzCX69DuqxFkVTRQnVy7LCFkVaZtjNAftnAHJjVgQw7lIhdGZp9q9\n' +
      'IafRt2gteihYfpn+EAQ/t/E4MnhrYs4CPLfS7BaYXBycEKC5Muj1l4GijNNQ0Efo\n' +
      'xG8LSZz7SNgUvfVwiNTaqfLP3AtEAWiqxyMyh3VO+1HpCjT7uNBFtmF3AgMBAAGj\n' +
      'ZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQW\n' +
      'BBQtinkdrj+0B2+qdXngV2tgHnPIujAfBgNVHSMEGDAWgBRp0xqULkNh/w2ZVzEI\n' +
      'o2RIY7O03TANBgkqhkiG9w0BAQsFAAOCAQEAtJdqbCxDeMc8VN1/RzCabw9BIL/z\n' +
      '73Auh8eFTww/sup26yn8NWUkfbckeDYr1BrXa+rPyLfHpg06kwR8rBKyrs5mHwJx\n' +
      'bvOzXD/5WTdgreB+2Fb7mXNvWhenYuji1MF+q1R2DXV3I05zWHteKX6Dajmx+Uuq\n' +
      'Yq78oaCBSV48hMxWlp8fm40ANCL1+gzQ122xweMFN09FmNYFhwuW+Ao+Vv90ZfQG\n' +
      'PYwTvN4n/gegw2TYcifGZC2PNX74q3DH03DXe5fvNgRW5plgz/7f+9mS+YHd5qa9\n' +
      'tYTPUvoRbi169ou6jicsMKUKPORHWhiTpSCWR1FMMIbsAcsyrvtIsuaGCQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEFjCCAv6gAwIBAgIJAMzYZJ+R9NBVMA0GCSqGSIb3DQEBCwUAMIGXMQswCQYD\n' +
      'VQQGEwJVUzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEi\n' +
      'MCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1h\n' +
      'em9uIFJEUzEoMCYGA1UEAwwfQW1hem9uIFJEUyBQcmV2aWV3IFJvb3QgMjAxOSBD\n' +
      'QTAeFw0xOTA4MjEyMjI5NDlaFw0yNDA4MjEyMjI5NDlaMIGXMQswCQYDVQQGEwJV\n' +
      'UzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEiMCAGA1UE\n' +
      'CgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJE\n' +
      'UzEoMCYGA1UEAwwfQW1hem9uIFJEUyBQcmV2aWV3IFJvb3QgMjAxOSBDQTCCASIw\n' +
      'DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAM7kkS6vjgKKQTPynC2NjdN5aPPV\n' +
      'O71G0JJS/2ARVBVJd93JLiGovVJilfWYfwZCs4gTRSSjrUD4D4HyqCd6A+eEEtJq\n' +
      'M0DEC7i0dC+9WNTsPszuB206Jy2IUmxZMIKJAA1NHSbIMjB+b6/JhbSUi7nKdbR/\n' +
      'brj83bF+RoSA+ogrgX7mQbxhmFcoZN9OGaJgYKsKWUt5Wqv627KkGodUK8mDepgD\n' +
      'S3ZfoRQRx3iceETpcmHJvaIge6+vyDX3d9Z22jmvQ4AKv3py2CmU2UwuhOltFDwB\n' +
      '0ddtb39vgwrJxaGfiMRHpEP1DfNLWHAnA69/pgZPwIggidS+iBPUhgucMp8CAwEA\n' +
      'AaNjMGEwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYE\n' +
      'FGnTGpQuQ2H/DZlXMQijZEhjs7TdMB8GA1UdIwQYMBaAFGnTGpQuQ2H/DZlXMQij\n' +
      'ZEhjs7TdMA0GCSqGSIb3DQEBCwUAA4IBAQC3xz1vQvcXAfpcZlngiRWeqU8zQAMQ\n' +
      'LZPCFNv7PVk4pmqX+ZiIRo4f9Zy7TrOVcboCnqmP/b/mNq0gVF4O+88jwXJZD+f8\n' +
      '/RnABMZcnGU+vK0YmxsAtYU6TIb1uhRFmbF8K80HHbj9vSjBGIQdPCbvmR2zY6VJ\n' +
      'BYM+w9U9hp6H4DVMLKXPc1bFlKA5OBTgUtgkDibWJKFOEPW3UOYwp9uq6pFoN0AO\n' +
      'xMTldqWFsOF3bJIlvOY0c/1EFZXu3Ns6/oCP//Ap9vumldYMUZWmbK+gK33FPOXV\n' +
      '8BQ6jNC29icv7lLDpRPwjibJBXX+peDR5UK4FdYcswWEB1Tix5X8dYu6\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECDCCAvCgAwIBAgICVIYwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MDQxNzEz\n' +
      'MDRaFw0yNDA4MjIxNzA4NTBaMIGVMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEmMCQGA1UEAwwdQW1h\n' +
      'em9uIFJEUyBhcC1zb3V0aC0xIDIwMTkgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n' +
      'DwAwggEKAoIBAQDUYOz1hGL42yUCrcsMSOoU8AeD/3KgZ4q7gP+vAz1WnY9K/kim\n' +
      'eWN/2Qqzlo3+mxSFQFyD4MyV3+CnCPnBl9Sh1G/F6kThNiJ7dEWSWBQGAB6HMDbC\n' +
      'BaAsmUc1UIz8sLTL3fO+S9wYhA63Wun0Fbm/Rn2yk/4WnJAaMZcEtYf6e0KNa0LM\n' +
      'p/kN/70/8cD3iz3dDR8zOZFpHoCtf0ek80QqTich0A9n3JLxR6g6tpwoYviVg89e\n' +
      'qCjQ4axxOkWWeusLeTJCcY6CkVyFvDAKvcUl1ytM5AiaUkXblE7zDFXRM4qMMRdt\n' +
      'lPm8d3pFxh0fRYk8bIKnpmtOpz3RIctDrZZxAgMBAAGjZjBkMA4GA1UdDwEB/wQE\n' +
      'AwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBT99wKJftD3jb4sHoHG\n' +
      'i3uGlH6W6TAfBgNVHSMEGDAWgBRzX2DYvMsDmPQrFzQuNlqmYP+8HzANBgkqhkiG\n' +
      '9w0BAQsFAAOCAQEAZ17hhr3dII3hUfuHQ1hPWGrpJOX/G9dLzkprEIcCidkmRYl+\n' +
      'hu1Pe3caRMh/17+qsoEErmnVq5jNY9X1GZL04IZH8YbHc7iRHw3HcWAdhN8633+K\n' +
      'jYEB2LbJ3vluCGnCejq9djDb6alOugdLMJzxOkHDhMZ6/gYbECOot+ph1tQuZXzD\n' +
      'tZ7prRsrcuPBChHlPjmGy8M9z8u+kF196iNSUGC4lM8vLkHM7ycc1/ZOwRq9aaTe\n' +
      'iOghbQQyAEe03MWCyDGtSmDfr0qEk+CHN+6hPiaL8qKt4s+V9P7DeK4iW08ny8Ox\n' +
      'AVS7u0OK/5+jKMAMrKwpYrBydOjTUTHScocyNw==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBjCCAu6gAwIBAgIJAMc0ZzaSUK51MA0GCSqGSIb3DQEBCwUAMIGPMQswCQYD\n' +
      'VQQGEwJVUzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEi\n' +
      'MCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1h\n' +
      'em9uIFJEUzEgMB4GA1UEAwwXQW1hem9uIFJEUyBSb290IDIwMTkgQ0EwHhcNMTkw\n' +
      'ODIyMTcwODUwWhcNMjQwODIyMTcwODUwWjCBjzELMAkGA1UEBhMCVVMxEDAOBgNV\n' +
      'BAcMB1NlYXR0bGUxEzARBgNVBAgMCldhc2hpbmd0b24xIjAgBgNVBAoMGUFtYXpv\n' +
      'biBXZWIgU2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMxIDAeBgNV\n' +
      'BAMMF0FtYXpvbiBSRFMgUm9vdCAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEFAAOC\n' +
      'AQ8AMIIBCgKCAQEArXnF/E6/Qh+ku3hQTSKPMhQQlCpoWvnIthzX6MK3p5a0eXKZ\n' +
      'oWIjYcNNG6UwJjp4fUXl6glp53Jobn+tWNX88dNH2n8DVbppSwScVE2LpuL+94vY\n' +
      '0EYE/XxN7svKea8YvlrqkUBKyxLxTjh+U/KrGOaHxz9v0l6ZNlDbuaZw3qIWdD/I\n' +
      '6aNbGeRUVtpM6P+bWIoxVl/caQylQS6CEYUk+CpVyJSkopwJlzXT07tMoDL5WgX9\n' +
      'O08KVgDNz9qP/IGtAcRduRcNioH3E9v981QO1zt/Gpb2f8NqAjUUCUZzOnij6mx9\n' +
      'McZ+9cWX88CRzR0vQODWuZscgI08NvM69Fn2SQIDAQABo2MwYTAOBgNVHQ8BAf8E\n' +
      'BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUc19g2LzLA5j0Kxc0LjZa\n' +
      'pmD/vB8wHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJKoZIhvcN\n' +
      'AQELBQADggEBAHAG7WTmyjzPRIM85rVj+fWHsLIvqpw6DObIjMWokpliCeMINZFV\n' +
      'ynfgBKsf1ExwbvJNzYFXW6dihnguDG9VMPpi2up/ctQTN8tm9nDKOy08uNZoofMc\n' +
      'NUZxKCEkVKZv+IL4oHoeayt8egtv3ujJM6V14AstMQ6SwvwvA93EP/Ug2e4WAXHu\n' +
      'cbI1NAbUgVDqp+DRdfvZkgYKryjTWd/0+1fS8X1bBZVWzl7eirNVnHbSH2ZDpNuY\n' +
      '0SBd8dj5F6ld3t58ydZbrTHze7JJOd8ijySAp4/kiu9UfZWuTPABzDa/DSdz9Dk/\n' +
      'zPW4CXXvhLmE02TA9/HeCw3KEHIwicNuEfw=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICQ2QwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MDUxODQ2\n' +
      'MjlaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyBzYS1lYXN0LTEgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBAMMvR+ReRnOzqJzoaPipNTt1Z2VA968jlN1+SYKUrYM3No+Vpz0H\n' +
      'M6Tn0oYB66ByVsXiGc28ulsqX1HbHsxqDPwvQTKvO7SrmDokoAkjJgLocOLUAeld\n' +
      '5AwvUjxGRP6yY90NV7X786MpnYb2Il9DIIaV9HjCmPt+rjy2CZjS0UjPjCKNfB8J\n' +
      'bFjgW6GGscjeyGb/zFwcom5p4j0rLydbNaOr9wOyQrtt3ZQWLYGY9Zees/b8pmcc\n' +
      'Jt+7jstZ2UMV32OO/kIsJ4rMUn2r/uxccPwAc1IDeRSSxOrnFKhW3Cu69iB3bHp7\n' +
      'JbawY12g7zshE4I14sHjv3QoXASoXjx4xgMCAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFI1Fc/Ql2jx+oJPgBVYq\n' +
      'ccgP0pQ8MB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQB4VVVabVp70myuYuZ3vltQIWqSUMhkaTzehMgGcHjMf9iLoZ/I\n' +
      '93KiFUSGnek5cRePyS9wcpp0fcBT3FvkjpUdCjVtdttJgZFhBxgTd8y26ImdDDMR\n' +
      '4+BUuhI5msvjL08f+Vkkpu1GQcGmyFVPFOy/UY8iefu+QyUuiBUnUuEDd49Hw0Fn\n' +
      '/kIPII6Vj82a2mWV/Q8e+rgN8dIRksRjKI03DEoP8lhPlsOkhdwU6Uz9Vu6NOB2Q\n' +
      'Ls1kbcxAc7cFSyRVJEhh12Sz9d0q/CQSTFsVJKOjSNQBQfVnLz1GwO/IieUEAr4C\n' +
      'jkTntH0r1LX5b/GwN4R887LvjAEdTbg1his7\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECDCCAvCgAwIBAgIDAIkHMA0GCSqGSIb3DQEBCwUAMIGPMQswCQYDVQQGEwJV\n' +
      'UzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEiMCAGA1UE\n' +
      'CgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJE\n' +
      'UzEgMB4GA1UEAwwXQW1hem9uIFJEUyBSb290IDIwMTkgQ0EwHhcNMTkwOTA2MTc0\n' +
      'MDIxWhcNMjQwODIyMTcwODUwWjCBlDELMAkGA1UEBhMCVVMxEzARBgNVBAgMCldh\n' +
      'c2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoMGUFtYXpvbiBXZWIg\n' +
      'U2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMxJTAjBgNVBAMMHEFt\n' +
      'YXpvbiBSRFMgdXMtd2VzdC0xIDIwMTkgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n' +
      'DwAwggEKAoIBAQDD2yzbbAl77OofTghDMEf624OvU0eS9O+lsdO0QlbfUfWa1Kd6\n' +
      '0WkgjkLZGfSRxEHMCnrv4UPBSK/Qwn6FTjkDLgemhqBtAnplN4VsoDL+BkRX4Wwq\n' +
      '/dSQJE2b+0hm9w9UMVGFDEq1TMotGGTD2B71eh9HEKzKhGzqiNeGsiX4VV+LJzdH\n' +
      'uM23eGisNqmd4iJV0zcAZ+Gbh2zK6fqTOCvXtm7Idccv8vZZnyk1FiWl3NR4WAgK\n' +
      'AkvWTIoFU3Mt7dIXKKClVmvssG8WHCkd3Xcb4FHy/G756UZcq67gMMTX/9fOFM/v\n' +
      'l5C0+CHl33Yig1vIDZd+fXV1KZD84dEJfEvHAgMBAAGjZjBkMA4GA1UdDwEB/wQE\n' +
      'AwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBR+ap20kO/6A7pPxo3+\n' +
      'T3CfqZpQWjAfBgNVHSMEGDAWgBRzX2DYvMsDmPQrFzQuNlqmYP+8HzANBgkqhkiG\n' +
      '9w0BAQsFAAOCAQEAHCJky2tPjPttlDM/RIqExupBkNrnSYnOK4kr9xJ3sl8UF2DA\n' +
      'PAnYsjXp3rfcjN/k/FVOhxwzi3cXJF/2Tjj39Bm/OEfYTOJDNYtBwB0VVH4ffa/6\n' +
      'tZl87jaIkrxJcreeeHqYMnIxeN0b/kliyA+a5L2Yb0VPjt9INq34QDc1v74FNZ17\n' +
      '4z8nr1nzg4xsOWu0Dbjo966lm4nOYIGBRGOKEkHZRZ4mEiMgr3YLkv8gSmeitx57\n' +
      'Z6dVemNtUic/LVo5Iqw4n3TBS0iF2C1Q1xT/s3h+0SXZlfOWttzSluDvoMv5PvCd\n' +
      'pFjNn+aXLAALoihL1MJSsxydtsLjOBro5eK0Vw==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEDDCCAvSgAwIBAgICOFAwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTAxNzQ2\n' +
      'MjFaFw0yNDA4MjIxNzA4NTBaMIGZMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEqMCgGA1UEAwwhQW1h\n' +
      'em9uIFJEUyBhcC1ub3J0aGVhc3QtMiAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEF\n' +
      'AAOCAQ8AMIIBCgKCAQEAzU72e6XbaJbi4HjJoRNjKxzUEuChKQIt7k3CWzNnmjc5\n' +
      '8I1MjCpa2W1iw1BYVysXSNSsLOtUsfvBZxi/1uyMn5ZCaf9aeoA9UsSkFSZBjOCN\n' +
      'DpKPCmfV1zcEOvJz26+1m8WDg+8Oa60QV0ou2AU1tYcw98fOQjcAES0JXXB80P2s\n' +
      '3UfkNcnDz+l4k7j4SllhFPhH6BQ4lD2NiFAP4HwoG6FeJUn45EPjzrydxjq6v5Fc\n' +
      'cQ8rGuHADVXotDbEhaYhNjIrsPL+puhjWfhJjheEw8c4whRZNp6gJ/b6WEes/ZhZ\n' +
      'h32DwsDsZw0BfRDUMgUn8TdecNexHUw8vQWeC181hwIDAQABo2YwZDAOBgNVHQ8B\n' +
      'Af8EBAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUwW9bWgkWkr0U\n' +
      'lrOsq2kvIdrECDgwHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJ\n' +
      'KoZIhvcNAQELBQADggEBAEugF0Gj7HVhX0ehPZoGRYRt3PBuI2YjfrrJRTZ9X5wc\n' +
      '9T8oHmw07mHmNy1qqWvooNJg09bDGfB0k5goC2emDiIiGfc/kvMLI7u+eQOoMKj6\n' +
      'mkfCncyRN3ty08Po45vTLBFZGUvtQmjM6yKewc4sXiASSBmQUpsMbiHRCL72M5qV\n' +
      'obcJOjGcIdDTmV1BHdWT+XcjynsGjUqOvQWWhhLPrn4jWe6Xuxll75qlrpn3IrIx\n' +
      'CRBv/5r7qbcQJPOgwQsyK4kv9Ly8g7YT1/vYBlR3cRsYQjccw5ceWUj2DrMVWhJ4\n' +
      'prf+E3Aa4vYmLLOUUvKnDQ1k3RGNu56V0tonsQbfsaM=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECjCCAvKgAwIBAgICEzUwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTAyMDUy\n' +
      'MjVaFw0yNDA4MjIxNzA4NTBaMIGXMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEoMCYGA1UEAwwfQW1h\n' +
      'em9uIFJEUyBjYS1jZW50cmFsLTEgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQAD\n' +
      'ggEPADCCAQoCggEBAOxHqdcPSA2uBjsCP4DLSlqSoPuQ/X1kkJLusVRKiQE2zayB\n' +
      'viuCBt4VB9Qsh2rW3iYGM+usDjltGnI1iUWA5KHcvHszSMkWAOYWLiMNKTlg6LCp\n' +
      'XnE89tvj5dIH6U8WlDvXLdjB/h30gW9JEX7S8supsBSci2GxEzb5mRdKaDuuF/0O\n' +
      'qvz4YE04pua3iZ9QwmMFuTAOYzD1M72aOpj+7Ac+YLMM61qOtU+AU6MndnQkKoQi\n' +
      'qmUN2A9IFaqHFzRlSdXwKCKUA4otzmz+/N3vFwjb5F4DSsbsrMfjeHMo6o/nb6Nh\n' +
      'YDb0VJxxPee6TxSuN7CQJ2FxMlFUezcoXqwqXD0CAwEAAaNmMGQwDgYDVR0PAQH/\n' +
      'BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFDGGpon9WfIpsggE\n' +
      'CxHq8hZ7E2ESMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqG\n' +
      'SIb3DQEBCwUAA4IBAQAvpeQYEGZvoTVLgV9rd2+StPYykMsmFjWQcyn3dBTZRXC2\n' +
      'lKq7QhQczMAOhEaaN29ZprjQzsA2X/UauKzLR2Uyqc2qOeO9/YOl0H3qauo8C/W9\n' +
      'r8xqPbOCDLEXlOQ19fidXyyEPHEq5WFp8j+fTh+s8WOx2M7IuC0ANEetIZURYhSp\n' +
      'xl9XOPRCJxOhj7JdelhpweX0BJDNHeUFi0ClnFOws8oKQ7sQEv66d5ddxqqZ3NVv\n' +
      'RbCvCtEutQMOUMIuaygDlMn1anSM8N7Wndx8G6+Uy67AnhjGx7jw/0YPPxopEj6x\n' +
      'JXP8j0sJbcT9K/9/fPVLNT25RvQ/93T2+IQL4Ca2\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICYpgwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTExNzMx\n' +
      'NDhaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyBldS13ZXN0LTEgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBAMk3YdSZ64iAYp6MyyKtYJtNzv7zFSnnNf6vv0FB4VnfITTMmOyZ\n' +
      'LXqKAT2ahZ00hXi34ewqJElgU6eUZT/QlzdIu359TEZyLVPwURflL6SWgdG01Q5X\n' +
      'O++7fSGcBRyIeuQWs9FJNIIqK8daF6qw0Rl5TXfu7P9dBc3zkgDXZm2DHmxGDD69\n' +
      '7liQUiXzoE1q2Z9cA8+jirDioJxN9av8hQt12pskLQumhlArsMIhjhHRgF03HOh5\n' +
      'tvi+RCfihVOxELyIRTRpTNiIwAqfZxxTWFTgfn+gijTmd0/1DseAe82aYic8JbuS\n' +
      'EMbrDduAWsqrnJ4GPzxHKLXX0JasCUcWyMECAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFPLtsq1NrwJXO13C9eHt\n' +
      'sLY11AGwMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQAnWBKj5xV1A1mYd0kIgDdkjCwQkiKF5bjIbGkT3YEFFbXoJlSP\n' +
      '0lZZ/hDaOHI8wbLT44SzOvPEEmWF9EE7SJzkvSdQrUAWR9FwDLaU427ALI3ngNHy\n' +
      'lGJ2hse1fvSRNbmg8Sc9GBv8oqNIBPVuw+AJzHTacZ1OkyLZrz1c1QvwvwN2a+Jd\n' +
      'vH0V0YIhv66llKcYDMUQJAQi4+8nbRxXWv6Gq3pvrFoorzsnkr42V3JpbhnYiK+9\n' +
      'nRKd4uWl62KRZjGkfMbmsqZpj2fdSWMY1UGyN1k+kDmCSWYdrTRDP0xjtIocwg+A\n' +
      'J116n4hV/5mbA0BaPiS2krtv17YAeHABZcvz\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECjCCAvKgAwIBAgICV2YwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTExOTM2\n' +
      'MjBaFw0yNDA4MjIxNzA4NTBaMIGXMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEoMCYGA1UEAwwfQW1h\n' +
      'em9uIFJEUyBldS1jZW50cmFsLTEgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQAD\n' +
      'ggEPADCCAQoCggEBAMEx54X2pHVv86APA0RWqxxRNmdkhAyp2R1cFWumKQRofoFv\n' +
      'n+SPXdkpIINpMuEIGJANozdiEz7SPsrAf8WHyD93j/ZxrdQftRcIGH41xasetKGl\n' +
      'I67uans8d+pgJgBKGb/Z+B5m+UsIuEVekpvgpwKtmmaLFC/NCGuSsJoFsRqoa6Gh\n' +
      'm34W6yJoY87UatddCqLY4IIXaBFsgK9Q/wYzYLbnWM6ZZvhJ52VMtdhcdzeTHNW0\n' +
      '5LGuXJOF7Ahb4JkEhoo6TS2c0NxB4l4MBfBPgti+O7WjR3FfZHpt18A6Zkq6A2u6\n' +
      'D/oTSL6c9/3sAaFTFgMyL3wHb2YlW0BPiljZIqECAwEAAaNmMGQwDgYDVR0PAQH/\n' +
      'BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFOcAToAc6skWffJa\n' +
      'TnreaswAfrbcMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqG\n' +
      'SIb3DQEBCwUAA4IBAQA1d0Whc1QtspK496mFWfFEQNegLh0a9GWYlJm+Htcj5Nxt\n' +
      'DAIGXb+8xrtOZFHmYP7VLCT5Zd2C+XytqseK/+s07iAr0/EPF+O2qcyQWMN5KhgE\n' +
      'cXw2SwuP9FPV3i+YAm11PBVeenrmzuk9NrdHQ7TxU4v7VGhcsd2C++0EisrmquWH\n' +
      'mgIfmVDGxphwoES52cY6t3fbnXmTkvENvR+h3rj+fUiSz0aSo+XZUGHPgvuEKM/W\n' +
      'CBD9Smc9CBoBgvy7BgHRgRUmwtABZHFUIEjHI5rIr7ZvYn+6A0O6sogRfvVYtWFc\n' +
      'qpyrW1YX8mD0VlJ8fGKM3G+aCOsiiPKDV/Uafrm+\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECDCCAvCgAwIBAgICGAcwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTIxODE5\n' +
      'NDRaFw0yNDA4MjIxNzA4NTBaMIGVMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEmMCQGA1UEAwwdQW1h\n' +
      'em9uIFJEUyBldS1ub3J0aC0xIDIwMTkgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n' +
      'DwAwggEKAoIBAQCiIYnhe4UNBbdBb/nQxl5giM0XoVHWNrYV5nB0YukA98+TPn9v\n' +
      'Aoj1RGYmtryjhrf01Kuv8SWO+Eom95L3zquoTFcE2gmxCfk7bp6qJJ3eHOJB+QUO\n' +
      'XsNRh76fwDzEF1yTeZWH49oeL2xO13EAx4PbZuZpZBttBM5zAxgZkqu4uWQczFEs\n' +
      'JXfla7z2fvWmGcTagX10O5C18XaFroV0ubvSyIi75ue9ykg/nlFAeB7O0Wxae88e\n' +
      'uhiBEFAuLYdqWnsg3459NfV8Yi1GnaitTym6VI3tHKIFiUvkSiy0DAlAGV2iiyJE\n' +
      'q+DsVEO4/hSINJEtII4TMtysOsYPpINqeEzRAgMBAAGjZjBkMA4GA1UdDwEB/wQE\n' +
      'AwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBRR0UpnbQyjnHChgmOc\n' +
      'hnlc0PogzTAfBgNVHSMEGDAWgBRzX2DYvMsDmPQrFzQuNlqmYP+8HzANBgkqhkiG\n' +
      '9w0BAQsFAAOCAQEAKJD4xVzSf4zSGTBJrmamo86jl1NHQxXUApAZuBZEc8tqC6TI\n' +
      'T5CeoSr9CMuVC8grYyBjXblC4OsM5NMvmsrXl/u5C9dEwtBFjo8mm53rOOIm1fxl\n' +
      'I1oYB/9mtO9ANWjkykuLzWeBlqDT/i7ckaKwalhLODsRDO73vRhYNjsIUGloNsKe\n' +
      'pxw3dzHwAZx4upSdEVG4RGCZ1D0LJ4Gw40OfD69hfkDfRVVxKGrbEzqxXRvovmDc\n' +
      'tKLdYZO/6REoca36v4BlgIs1CbUXJGLSXUwtg7YXGLSVBJ/U0+22iGJmBSNcoyUN\n' +
      'cjPFD9JQEhDDIYYKSGzIYpvslvGc4T5ISXFiuQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICZIEwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTIyMTMy\n' +
      'MzJaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyBldS13ZXN0LTIgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBALGiwqjiF7xIjT0Sx7zB3764K2T2a1DHnAxEOr+/EIftWKxWzT3u\n' +
      'PFwS2eEZcnKqSdRQ+vRzonLBeNLO4z8aLjQnNbkizZMBuXGm4BqRm1Kgq3nlLDQn\n' +
      '7YqdijOq54SpShvR/8zsO4sgMDMmHIYAJJOJqBdaus2smRt0NobIKc0liy7759KB\n' +
      '6kmQ47Gg+kfIwxrQA5zlvPLeQImxSoPi9LdbRoKvu7Iot7SOa+jGhVBh3VdqndJX\n' +
      '7tm/saj4NE375csmMETFLAOXjat7zViMRwVorX4V6AzEg1vkzxXpA9N7qywWIT5Y\n' +
      'fYaq5M8i6vvLg0CzrH9fHORtnkdjdu1y+0MCAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFFOhOx1yt3Z7mvGB9jBv\n' +
      '2ymdZwiOMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQBehqY36UGDvPVU9+vtaYGr38dBbp+LzkjZzHwKT1XJSSUc2wqM\n' +
      'hnCIQKilonrTIvP1vmkQi8qHPvDRtBZKqvz/AErW/ZwQdZzqYNFd+BmOXaeZWV0Q\n' +
      'oHtDzXmcwtP8aUQpxN0e1xkWb1E80qoy+0uuRqb/50b/R4Q5qqSfJhkn6z8nwB10\n' +
      '7RjLtJPrK8igxdpr3tGUzfAOyiPrIDncY7UJaL84GFp7WWAkH0WG3H8Y8DRcRXOU\n' +
      'mqDxDLUP3rNuow3jnGxiUY+gGX5OqaZg4f4P6QzOSmeQYs6nLpH0PiN00+oS1BbD\n' +
      'bpWdZEttILPI+vAYkU4QuBKKDjJL6HbSd+cn\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIECDCCAvCgAwIBAgIDAIVCMA0GCSqGSIb3DQEBCwUAMIGPMQswCQYDVQQGEwJV\n' +
      'UzEQMA4GA1UEBwwHU2VhdHRsZTETMBEGA1UECAwKV2FzaGluZ3RvbjEiMCAGA1UE\n' +
      'CgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJE\n' +
      'UzEgMB4GA1UEAwwXQW1hem9uIFJEUyBSb290IDIwMTkgQ0EwHhcNMTkwOTEzMTcw\n' +
      'NjQxWhcNMjQwODIyMTcwODUwWjCBlDELMAkGA1UEBhMCVVMxEzARBgNVBAgMCldh\n' +
      'c2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxIjAgBgNVBAoMGUFtYXpvbiBXZWIg\n' +
      'U2VydmljZXMsIEluYy4xEzARBgNVBAsMCkFtYXpvbiBSRFMxJTAjBgNVBAMMHEFt\n' +
      'YXpvbiBSRFMgdXMtZWFzdC0yIDIwMTkgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n' +
      'DwAwggEKAoIBAQDE+T2xYjUbxOp+pv+gRA3FO24+1zCWgXTDF1DHrh1lsPg5k7ht\n' +
      '2KPYzNc+Vg4E+jgPiW0BQnA6jStX5EqVh8BU60zELlxMNvpg4KumniMCZ3krtMUC\n' +
      'au1NF9rM7HBh+O+DYMBLK5eSIVt6lZosOb7bCi3V6wMLA8YqWSWqabkxwN4w0vXI\n' +
      '8lu5uXXFRemHnlNf+yA/4YtN4uaAyd0ami9+klwdkZfkrDOaiy59haOeBGL8EB/c\n' +
      'dbJJlguHH5CpCscs3RKtOOjEonXnKXldxarFdkMzi+aIIjQ8GyUOSAXHtQHb3gZ4\n' +
      'nS6Ey0CMlwkB8vUObZU9fnjKJcL5QCQqOfwvAgMBAAGjZjBkMA4GA1UdDwEB/wQE\n' +
      'AwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBQUPuRHohPxx4VjykmH\n' +
      '6usGrLL1ETAfBgNVHSMEGDAWgBRzX2DYvMsDmPQrFzQuNlqmYP+8HzANBgkqhkiG\n' +
      '9w0BAQsFAAOCAQEAUdR9Vb3y33Yj6X6KGtuthZ08SwjImVQPtknzpajNE5jOJAh8\n' +
      'quvQnU9nlnMO85fVDU1Dz3lLHGJ/YG1pt1Cqq2QQ200JcWCvBRgdvH6MjHoDQpqZ\n' +
      'HvQ3vLgOGqCLNQKFuet9BdpsHzsctKvCVaeBqbGpeCtt3Hh/26tgx0rorPLw90A2\n' +
      'V8QSkZJjlcKkLa58N5CMM8Xz8KLWg3MZeT4DmlUXVCukqK2RGuP2L+aME8dOxqNv\n' +
      'OnOz1zrL5mR2iJoDpk8+VE/eBDmJX40IJk6jBjWoxAO/RXq+vBozuF5YHN1ujE92\n' +
      'tO8HItgTp37XT8bJBAiAnt5mxw+NLSqtxk2QdQ==\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEDDCCAvSgAwIBAgICY4kwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTMyMDEx\n' +
      'NDJaFw0yNDA4MjIxNzA4NTBaMIGZMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEqMCgGA1UEAwwhQW1h\n' +
      'em9uIFJEUyBhcC1zb3V0aGVhc3QtMSAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEF\n' +
      'AAOCAQ8AMIIBCgKCAQEAr5u9OuLL/OF/fBNUX2kINJLzFl4DnmrhnLuSeSnBPgbb\n' +
      'qddjf5EFFJBfv7IYiIWEFPDbDG5hoBwgMup5bZDbas+ZTJTotnnxVJTQ6wlhTmns\n' +
      'eHECcg2pqGIKGrxZfbQhlj08/4nNAPvyYCTS0bEcmQ1emuDPyvJBYDDLDU6AbCB5\n' +
      '6Z7YKFQPTiCBblvvNzchjLWF9IpkqiTsPHiEt21sAdABxj9ityStV3ja/W9BfgxH\n' +
      'wzABSTAQT6FbDwmQMo7dcFOPRX+hewQSic2Rn1XYjmNYzgEHisdUsH7eeXREAcTw\n' +
      '61TRvaLH8AiOWBnTEJXPAe6wYfrcSd1pD0MXpoB62wIDAQABo2YwZDAOBgNVHQ8B\n' +
      'Af8EBAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUytwMiomQOgX5\n' +
      'Ichd+2lDWRUhkikwHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJ\n' +
      'KoZIhvcNAQELBQADggEBACf6lRDpfCD7BFRqiWM45hqIzffIaysmVfr+Jr+fBTjP\n' +
      'uYe/ba1omSrNGG23bOcT9LJ8hkQJ9d+FxUwYyICQNWOy6ejicm4z0C3VhphbTPqj\n' +
      'yjpt9nG56IAcV8BcRJh4o/2IfLNzC/dVuYJV8wj7XzwlvjysenwdrJCoLadkTr1h\n' +
      'eIdG6Le07sB9IxrGJL9e04afk37h7c8ESGSE4E+oS4JQEi3ATq8ne1B9DQ9SasXi\n' +
      'IRmhNAaISDzOPdyLXi9N9V9Lwe/DHcja7hgLGYx3UqfjhLhOKwp8HtoZORixAmOI\n' +
      'HfILgNmwyugAbuZoCazSKKBhQ0wgO0WZ66ZKTMG8Oho=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICUYkwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTYxODIx\n' +
      'MTVaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyB1cy13ZXN0LTIgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBANCEZBZyu6yJQFZBJmSUZfSZd3Ui2gitczMKC4FLr0QzkbxY+cLa\n' +
      'uVONIOrPt4Rwi+3h/UdnUg917xao3S53XDf1TDMFEYp4U8EFPXqCn/GXBIWlU86P\n' +
      'PvBN+gzw3nS+aco7WXb+woTouvFVkk8FGU7J532llW8o/9ydQyDIMtdIkKTuMfho\n' +
      'OiNHSaNc+QXQ32TgvM9A/6q7ksUoNXGCP8hDOkSZ/YOLiI5TcdLh/aWj00ziL5bj\n' +
      'pvytiMZkilnc9dLY9QhRNr0vGqL0xjmWdoEXz9/OwjmCihHqJq+20MJPsvFm7D6a\n' +
      '2NKybR9U+ddrjb8/iyLOjURUZnj5O+2+OPcCAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFEBxMBdv81xuzqcK5TVu\n' +
      'pHj+Aor8MB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQBZkfiVqGoJjBI37aTlLOSjLcjI75L5wBrwO39q+B4cwcmpj58P\n' +
      '3sivv+jhYfAGEbQnGRzjuFoyPzWnZ1DesRExX+wrmHsLLQbF2kVjLZhEJMHF9eB7\n' +
      'GZlTPdTzHErcnuXkwA/OqyXMpj9aghcQFuhCNguEfnROY9sAoK2PTfnTz9NJHL+Q\n' +
      'UpDLEJEUfc0GZMVWYhahc0x38ZnSY2SKacIPECQrTI0KpqZv/P+ijCEcMD9xmYEb\n' +
      'jL4en+XKS1uJpw5fIU5Sj0MxhdGstH6S84iAE5J3GM3XHklGSFwwqPYvuTXvANH6\n' +
      'uboynxRgSae59jIlAK6Jrr6GWMwQRbgcaAlW\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEDDCCAvSgAwIBAgICEkYwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTYxOTUz\n' +
      'NDdaFw0yNDA4MjIxNzA4NTBaMIGZMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEqMCgGA1UEAwwhQW1h\n' +
      'em9uIFJEUyBhcC1zb3V0aGVhc3QtMiAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEF\n' +
      'AAOCAQ8AMIIBCgKCAQEAufodI2Flker8q7PXZG0P0vmFSlhQDw907A6eJuF/WeMo\n' +
      'GHnll3b4S6nC3oRS3nGeRMHbyU2KKXDwXNb3Mheu+ox+n5eb/BJ17eoj9HbQR1cd\n' +
      'gEkIciiAltf8gpMMQH4anP7TD+HNFlZnP7ii3geEJB2GGXSxgSWvUzH4etL67Zmn\n' +
      'TpGDWQMB0T8lK2ziLCMF4XAC/8xDELN/buHCNuhDpxpPebhct0T+f6Arzsiswt2j\n' +
      '7OeNeLLZwIZvVwAKF7zUFjC6m7/VmTQC8nidVY559D6l0UhhU0Co/txgq3HVsMOH\n' +
      'PbxmQUwJEKAzQXoIi+4uZzHFZrvov/nDTNJUhC6DqwIDAQABo2YwZDAOBgNVHQ8B\n' +
      'Af8EBAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUwaZpaCme+EiV\n' +
      'M5gcjeHZSTgOn4owHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJ\n' +
      'KoZIhvcNAQELBQADggEBAAR6a2meCZuXO2TF9bGqKGtZmaah4pH2ETcEVUjkvXVz\n' +
      'sl+ZKbYjrun+VkcMGGKLUjS812e7eDF726ptoku9/PZZIxlJB0isC/0OyixI8N4M\n' +
      'NsEyvp52XN9QundTjkl362bomPnHAApeU0mRbMDRR2JdT70u6yAzGLGsUwMkoNnw\n' +
      '1VR4XKhXHYGWo7KMvFrZ1KcjWhubxLHxZWXRulPVtGmyWg/MvE6KF+2XMLhojhUL\n' +
      '+9jB3Fpn53s6KMx5tVq1x8PukHmowcZuAF8k+W4gk8Y68wIwynrdZrKRyRv6CVtR\n' +
      'FZ8DeJgoNZT3y/GT254VqMxxfuy2Ccb/RInd16tEvVk=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEDDCCAvSgAwIBAgICOYIwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTcyMDA1\n' +
      'MjlaFw0yNDA4MjIxNzA4NTBaMIGZMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEqMCgGA1UEAwwhQW1h\n' +
      'em9uIFJEUyBhcC1ub3J0aGVhc3QtMyAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEF\n' +
      'AAOCAQ8AMIIBCgKCAQEA4dMak8W+XW8y/2F6nRiytFiA4XLwePadqWebGtlIgyCS\n' +
      'kbug8Jv5w7nlMkuxOxoUeD4WhI6A9EkAn3r0REM/2f0aYnd2KPxeqS2MrtdxxHw1\n' +
      'xoOxk2x0piNSlOz6yog1idsKR5Wurf94fvM9FdTrMYPPrDabbGqiBMsZZmoHLvA3\n' +
      'Z+57HEV2tU0Ei3vWeGIqnNjIekS+E06KhASxrkNU5vi611UsnYZlSi0VtJsH4UGV\n' +
      'LhnHl53aZL0YFO5mn/fzuNG/51qgk/6EFMMhaWInXX49Dia9FnnuWXwVwi6uX1Wn\n' +
      '7kjoHi5VtmC8ZlGEHroxX2DxEr6bhJTEpcLMnoQMqwIDAQABo2YwZDAOBgNVHQ8B\n' +
      'Af8EBAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUsUI5Cb3SWB8+\n' +
      'gv1YLN/ABPMdxSAwHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJ\n' +
      'KoZIhvcNAQELBQADggEBAJAF3E9PM1uzVL8YNdzb6fwJrxxqI2shvaMVmC1mXS+w\n' +
      'G0zh4v2hBZOf91l1EO0rwFD7+fxoI6hzQfMxIczh875T6vUXePKVOCOKI5wCrDad\n' +
      'zQbVqbFbdhsBjF4aUilOdtw2qjjs9JwPuB0VXN4/jY7m21oKEOcnpe36+7OiSPjN\n' +
      'xngYewCXKrSRqoj3mw+0w/+exYj3Wsush7uFssX18av78G+ehKPIVDXptOCP/N7W\n' +
      '8iKVNeQ2QGTnu2fzWsGUSvMGyM7yqT+h1ILaT//yQS8er511aHMLc142bD4D9VSy\n' +
      'DgactwPDTShK/PXqhvNey9v/sKXm4XatZvwcc8KYlW4=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEDDCCAvSgAwIBAgICcEUwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTgxNjU2\n' +
      'MjBaFw0yNDA4MjIxNzA4NTBaMIGZMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzEqMCgGA1UEAwwhQW1h\n' +
      'em9uIFJEUyBhcC1ub3J0aGVhc3QtMSAyMDE5IENBMIIBIjANBgkqhkiG9w0BAQEF\n' +
      'AAOCAQ8AMIIBCgKCAQEAndtkldmHtk4TVQAyqhAvtEHSMb6pLhyKrIFved1WO3S7\n' +
      '+I+bWwv9b2W/ljJxLq9kdT43bhvzonNtI4a1LAohS6bqyirmk8sFfsWT3akb+4Sx\n' +
      '1sjc8Ovc9eqIWJCrUiSvv7+cS7ZTA9AgM1PxvHcsqrcUXiK3Jd/Dax9jdZE1e15s\n' +
      'BEhb2OEPE+tClFZ+soj8h8Pl2Clo5OAppEzYI4LmFKtp1X/BOf62k4jviXuCSst3\n' +
      'UnRJzE/CXtjmN6oZySVWSe0rQYuyqRl6//9nK40cfGKyxVnimB8XrrcxUN743Vud\n' +
      'QQVU0Esm8OVTX013mXWQXJHP2c0aKkog8LOga0vobQIDAQABo2YwZDAOBgNVHQ8B\n' +
      'Af8EBAMCAQYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQULmoOS1mFSjj+\n' +
      'snUPx4DgS3SkLFYwHwYDVR0jBBgwFoAUc19g2LzLA5j0Kxc0LjZapmD/vB8wDQYJ\n' +
      'KoZIhvcNAQELBQADggEBAAkVL2P1M2/G9GM3DANVAqYOwmX0Xk58YBHQu6iiQg4j\n' +
      'b4Ky/qsZIsgT7YBsZA4AOcPKQFgGTWhe9pvhmXqoN3RYltN8Vn7TbUm/ZVDoMsrM\n' +
      'gwv0+TKxW1/u7s8cXYfHPiTzVSJuOogHx99kBW6b2f99GbP7O1Sv3sLq4j6lVvBX\n' +
      'Fiacf5LAWC925nvlTzLlBgIc3O9xDtFeAGtZcEtxZJ4fnGXiqEnN4539+nqzIyYq\n' +
      'nvlgCzyvcfRAxwltrJHuuRu6Maw5AGcd2Y0saMhqOVq9KYKFKuD/927BTrbd2JVf\n' +
      '2sGWyuPZPCk3gq+5pCjbD0c6DkhcMGI6WwxvM5V/zSM=\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICJDQwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTgxNzAz\n' +
      'MTVaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyBldS13ZXN0LTMgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBAL9bL7KE0n02DLVtlZ2PL+g/BuHpMYFq2JnE2RgompGurDIZdjmh\n' +
      '1pxfL3nT+QIVMubuAOy8InRfkRxfpxyjKYdfLJTPJG+jDVL+wDcPpACFVqoV7Prg\n' +
      'pVYEV0lc5aoYw4bSeYFhdzgim6F8iyjoPnObjll9mo4XsHzSoqJLCd0QC+VG9Fw2\n' +
      'q+GDRZrLRmVM2oNGDRbGpGIFg77aRxRapFZa8SnUgs2AqzuzKiprVH5i0S0M6dWr\n' +
      'i+kk5epmTtkiDHceX+dP/0R1NcnkCPoQ9TglyXyPdUdTPPRfKCq12dftqll+u4mV\n' +
      'ARdN6WFjovxax8EAP2OAUTi1afY+1JFMj+sCAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFLfhrbrO5exkCVgxW0x3\n' +
      'Y2mAi8lNMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQAigQ5VBNGyw+OZFXwxeJEAUYaXVoP/qrhTOJ6mCE2DXUVEoJeV\n' +
      'SxScy/TlFA9tJXqmit8JH8VQ/xDL4ubBfeMFAIAo4WzNWDVoeVMqphVEcDWBHsI1\n' +
      'AETWzfsapRS9yQekOMmxg63d/nV8xewIl8aNVTHdHYXMqhhik47VrmaVEok1UQb3\n' +
      'O971RadLXIEbVd9tjY5bMEHm89JsZDnDEw1hQXBb67Elu64OOxoKaHBgUH8AZn/2\n' +
      'zFsL1ynNUjOhCSAA15pgd1vjwc0YsBbAEBPcHBWYBEyME6NLNarjOzBl4FMtATSF\n' +
      'wWCKRGkvqN8oxYhwR2jf2rR5Mu4DWkK5Q8Ep\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIEBzCCAu+gAwIBAgICJVUwDQYJKoZIhvcNAQELBQAwgY8xCzAJBgNVBAYTAlVT\n' +
      'MRAwDgYDVQQHDAdTZWF0dGxlMRMwEQYDVQQIDApXYXNoaW5ndG9uMSIwIAYDVQQK\n' +
      'DBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMuMRMwEQYDVQQLDApBbWF6b24gUkRT\n' +
      'MSAwHgYDVQQDDBdBbWF6b24gUkRTIFJvb3QgMjAxOSBDQTAeFw0xOTA5MTkxODE2\n' +
      'NTNaFw0yNDA4MjIxNzA4NTBaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECAwKV2Fz\n' +
      'aGluZ3RvbjEQMA4GA1UEBwwHU2VhdHRsZTEiMCAGA1UECgwZQW1hem9uIFdlYiBT\n' +
      'ZXJ2aWNlcywgSW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzElMCMGA1UEAwwcQW1h\n' +
      'em9uIFJEUyB1cy1lYXN0LTEgMjAxOSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP\n' +
      'ADCCAQoCggEBAM3i/k2u6cqbMdcISGRvh+m+L0yaSIoOXjtpNEoIftAipTUYoMhL\n' +
      'InXGlQBVA4shkekxp1N7HXe1Y/iMaPEyb3n+16pf3vdjKl7kaSkIhjdUz3oVUEYt\n' +
      'i8Z/XeJJ9H2aEGuiZh3kHixQcZczn8cg3dA9aeeyLSEnTkl/npzLf//669Ammyhs\n' +
      'XcAo58yvT0D4E0D/EEHf2N7HRX7j/TlyWvw/39SW0usiCrHPKDLxByLojxLdHzso\n' +
      'QIp/S04m+eWn6rmD+uUiRteN1hI5ncQiA3wo4G37mHnUEKo6TtTUh+sd/ku6a8HK\n' +
      'glMBcgqudDI90s1OpuIAWmuWpY//8xEG2YECAwEAAaNmMGQwDgYDVR0PAQH/BAQD\n' +
      'AgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFPqhoWZcrVY9mU7tuemR\n' +
      'RBnQIj1jMB8GA1UdIwQYMBaAFHNfYNi8ywOY9CsXNC42WqZg/7wfMA0GCSqGSIb3\n' +
      'DQEBCwUAA4IBAQB6zOLZ+YINEs72heHIWlPZ8c6WY8MDU+Be5w1M+BK2kpcVhCUK\n' +
      'PJO4nMXpgamEX8DIiaO7emsunwJzMSvavSPRnxXXTKIc0i/g1EbiDjnYX9d85DkC\n' +
      'E1LaAUCmCZBVi9fIe0H2r9whIh4uLWZA41oMnJx/MOmo3XyMfQoWcqaSFlMqfZM4\n' +
      '0rNoB/tdHLNuV4eIdaw2mlHxdWDtF4oH+HFm+2cVBUVC1jXKrFv/euRVtsTT+A6i\n' +
      'h2XBHKxQ1Y4HgAn0jACP2QSPEmuoQEIa57bEKEcZsBR8SDY6ZdTd2HLRIApcCOSF\n' +
      'MRM8CKLeF658I0XgF8D5EsYoKPsA+74Z+jDH\n' +
      '-----END CERTIFICATE-----\n',
    '-----BEGIN CERTIFICATE-----\n' +
      'MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF\n' +
      'ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6\n' +
      'b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL\n' +
      'MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv\n' +
      'b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj\n' +
      'ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM\n' +
      '9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw\n' +
      'IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6\n' +
      'VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L\n' +
      '93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm\n' +
      'jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC\n' +
      'AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA\n' +
      'A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI\n' +
      'U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs\n' +
      'N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv\n' +
      'o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU\n' +
      '5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy\n' +
      'rqXRfboQnoZsG4q5WTP468SQvvG5\n' +
      '-----END CERTIFICATE-----\n'
  ]
};

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528833, function(require, module, exports) {


const core = require('./index.js');
const EventEmitter = require('events').EventEmitter;

function makeDoneCb(resolve, reject, localErr) {
  return function (err, rows, fields) {
    if (err) {
      localErr.message = err.message;
      localErr.code = err.code;
      localErr.errno = err.errno;
      localErr.sqlState = err.sqlState;
      localErr.sqlMessage = err.sqlMessage;
      reject(localErr);
    } else {
      resolve([rows, fields]);
    }
  };
}

function inheritEvents(source, target, events) {
  const listeners = {};
  target
    .on('newListener', eventName => {
      if (events.indexOf(eventName) >= 0 && !target.listenerCount(eventName)) {
        source.on(
          eventName,
          (listeners[eventName] = function () {
            const args = [].slice.call(arguments);
            args.unshift(eventName);

            target.emit.apply(target, args);
          })
        );
      }
    })
    .on('removeListener', eventName => {
      if (events.indexOf(eventName) >= 0 && !target.listenerCount(eventName)) {
        source.removeListener(eventName, listeners[eventName]);
        delete listeners[eventName];
      }
    });
}

class PromisePreparedStatementInfo {
  constructor(statement, promiseImpl) {
    this.statement = statement;
    this.Promise = promiseImpl;
  }

  execute(parameters) {
    const s = this.statement;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      if (parameters) {
        s.execute(parameters, done);
      } else {
        s.execute(done);
      }
    });
  }

  close() {
    return new this.Promise(resolve => {
      this.statement.close();
      resolve();
    });
  }
}

class PromiseConnection extends EventEmitter {
  constructor(connection, promiseImpl) {
    super();
    this.connection = connection;
    this.Promise = promiseImpl || Promise;
    inheritEvents(connection, this, [
      'error',
      'drain',
      'connect',
      'end',
      'enqueue'
    ]);
  }

  release() {
    this.connection.release();
  }

  query(query, params) {
    const c = this.connection;
    const localErr = new Error();
    if (typeof params === 'function') {
      throw new Error(
        'Callback function is not available with promise clients.'
      );
    }
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      if (params !== undefined) {
        c.query(query, params, done);
      } else {
        c.query(query, done);
      }
    });
  }

  execute(query, params) {
    const c = this.connection;
    const localErr = new Error();
    if (typeof params === 'function') {
      throw new Error(
        'Callback function is not available with promise clients.'
      );
    }
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      if (params !== undefined) {
        c.execute(query, params, done);
      } else {
        c.execute(query, done);
      }
    });
  }

  end() {
    return new this.Promise(resolve => {
      this.connection.end(resolve);
    });
  }

  beginTransaction() {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      c.beginTransaction(done);
    });
  }

  commit() {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      c.commit(done);
    });
  }

  rollback() {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      c.rollback(done);
    });
  }

  ping() {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      c.ping(done);
    });
  }

  connect() {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      c.connect((err, param) => {
        if (err) {
          localErr.message = err.message;
          localErr.code = err.code;
          localErr.errno = err.errno;
          localErr.sqlState = err.sqlState;
          localErr.sqlMessage = err.sqlMessage;
          reject(localErr);
        } else {
          resolve(param);
        }
      });
    });
  }

  prepare(options) {
    const c = this.connection;
    const promiseImpl = this.Promise;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      c.prepare(options, (err, statement) => {
        if (err) {
          localErr.message = err.message;
          localErr.code = err.code;
          localErr.errno = err.errno;
          localErr.sqlState = err.sqlState;
          localErr.sqlMessage = err.sqlMessage;
          reject(localErr);
        } else {
          const wrappedStatement = new PromisePreparedStatementInfo(
            statement,
            promiseImpl
          );
          resolve(wrappedStatement);
        }
      });
    });
  }

  changeUser(options) {
    const c = this.connection;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      c.changeUser(options, err => {
        if (err) {
          localErr.message = err.message;
          localErr.code = err.code;
          localErr.errno = err.errno;
          localErr.sqlState = err.sqlState;
          localErr.sqlMessage = err.sqlMessage;
          reject(localErr);
        } else {
          resolve();
        }
      });
    });
  }

  get config() {
    return this.connection.config;
  }

  get threadId() {
    return this.connection.threadId;
  }
}

function createConnection(opts) {
  const coreConnection = core.createConnection(opts);
  const createConnectionErr = new Error();
  const thePromise = opts.Promise || Promise;
  if (!thePromise) {
    throw new Error(
      'no Promise implementation available.' +
      'Use promise-enabled node version or pass userland Promise' +
      " implementation as parameter, for example: { Promise: require('bluebird') }"
    );
  }
  return new thePromise((resolve, reject) => {
    coreConnection.once('connect', () => {
      resolve(new PromiseConnection(coreConnection, thePromise));
    });
    coreConnection.once('error', err => {
      createConnectionErr.message = err.message;
      createConnectionErr.code = err.code;
      createConnectionErr.errno = err.errno;
      createConnectionErr.sqlState = err.sqlState;
      reject(createConnectionErr);
    });
  });
}

// note: the callback of "changeUser" is not called on success
// hence there is no possibility to call "resolve"

// patching PromiseConnection
// create facade functions for prototype functions on "Connection" that are not yet
// implemented with PromiseConnection

// proxy synchronous functions only
(function (functionsToWrap) {
  for (let i = 0; functionsToWrap && i < functionsToWrap.length; i++) {
    const func = functionsToWrap[i];

    if (
      typeof core.Connection.prototype[func] === 'function' &&
      PromiseConnection.prototype[func] === undefined
    ) {
      PromiseConnection.prototype[func] = (function factory(funcName) {
        return function () {
          return core.Connection.prototype[funcName].apply(
            this.connection,
            arguments
          );
        };
      })(func);
    }
  }
})([
  // synchronous functions
  'close',
  'createBinlogStream',
  'destroy',
  'escape',
  'escapeId',
  'format',
  'pause',
  'pipe',
  'resume',
  'unprepare'
]);

class PromisePoolConnection extends PromiseConnection {
  constructor(connection, promiseImpl) {
    super(connection, promiseImpl);
  }

  destroy() {
    return core.PoolConnection.prototype.destroy.apply(
      this.connection,
      arguments
    );
  }
}

class PromisePool extends EventEmitter {
  constructor(pool, thePromise) {
    super();
    this.pool = pool;
    this.Promise = thePromise || Promise;
    inheritEvents(pool, this, ['acquire', 'connection', 'enqueue', 'release']);
  }

  getConnection() {
    const corePool = this.pool;
    return new this.Promise((resolve, reject) => {
      corePool.getConnection((err, coreConnection) => {
        if (err) {
          reject(err);
        } else {
          resolve(new PromisePoolConnection(coreConnection, this.Promise));
        }
      });
    });
  }

  query(sql, args) {
    const corePool = this.pool;
    const localErr = new Error();
    if (typeof args === 'function') {
      throw new Error(
        'Callback function is not available with promise clients.'
      );
    }
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      if (args !== undefined) {
        corePool.query(sql, args, done);
      } else {
        corePool.query(sql, done);
      }
    });
  }

  execute(sql, args) {
    const corePool = this.pool;
    const localErr = new Error();
    if (typeof args === 'function') {
      throw new Error(
        'Callback function is not available with promise clients.'
      );
    }
    return new this.Promise((resolve, reject) => {
      const done = makeDoneCb(resolve, reject, localErr);
      if (args) {
        corePool.execute(sql, args, done);
      } else {
        corePool.execute(sql, done);
      }
    });
  }

  end() {
    const corePool = this.pool;
    const localErr = new Error();
    return new this.Promise((resolve, reject) => {
      corePool.end(err => {
        if (err) {
          localErr.message = err.message;
          localErr.code = err.code;
          localErr.errno = err.errno;
          localErr.sqlState = err.sqlState;
          localErr.sqlMessage = err.sqlMessage;
          reject(localErr);
        } else {
          resolve();
        }
      });
    });
  }
}

function createPool(opts) {
  const corePool = core.createPool(opts);
  const thePromise = opts.Promise || Promise;
  if (!thePromise) {
    throw new Error(
      'no Promise implementation available.' +
      'Use promise-enabled node version or pass userland Promise' +
      " implementation as parameter, for example: { Promise: require('bluebird') }"
    );
  }

  return new PromisePool(corePool, thePromise);
}

(function (functionsToWrap) {
  for (let i = 0; functionsToWrap && i < functionsToWrap.length; i++) {
    const func = functionsToWrap[i];

    if (
      typeof core.Pool.prototype[func] === 'function' &&
      PromisePool.prototype[func] === undefined
    ) {
      PromisePool.prototype[func] = (function factory(funcName) {
        return function () {
          return core.Pool.prototype[funcName].apply(this.pool, arguments);
        };
      })(func);
    }
  }
})([
  // synchronous functions
  'escape',
  'escapeId',
  'format'
]);

exports.createConnection = createConnection;
exports.createPool = createPool;
exports.escape = core.escape;
exports.escapeId = core.escapeId;
exports.format = core.format;
exports.raw = core.raw;
exports.PromisePool = PromisePool;
exports.PromiseConnection = PromiseConnection;
exports.PromisePoolConnection = PromisePoolConnection;

}, function(modId) { var map = {"./index.js":1619928528772}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528834, function(require, module, exports) {


const process = require('process');
const mysql = require('../index.js');

const EventEmitter = require('events').EventEmitter;
const PoolConnection = require('./pool_connection.js');
const Queue = require('denque');
const Connection = require('./connection.js');

function spliceConnection(queue, connection) {
  const len = queue.length;
  for (let i = 0; i < len; i++) {
    if (queue.get(i) === connection) {
      queue.removeOne(i);
      break;
    }
  }
}

class Pool extends EventEmitter {
  constructor(options) {
    super();
    this.config = options.config;
    this.config.connectionConfig.pool = this;
    this._allConnections = new Queue();
    this._freeConnections = new Queue();
    this._connectionQueue = new Queue();
    this._closed = false;
  }

  promise(promiseImpl) {
    const PromisePool = require('../promise').PromisePool;
    return new PromisePool(this, promiseImpl);
  }

  getConnection(cb) {
    if (this._closed) {
      return process.nextTick(() => cb(new Error('Pool is closed.')));
    }
    let connection;
    if (this._freeConnections.length > 0) {
      connection = this._freeConnections.shift();
      this.emit('acquire', connection);
      return process.nextTick(() => cb(null, connection));
    }
    if (
      this.config.connectionLimit === 0 ||
      this._allConnections.length < this.config.connectionLimit
    ) {
      connection = new PoolConnection(this, {
        config: this.config.connectionConfig
      });
      this._allConnections.push(connection);
      return connection.connect(err => {
        if (this._closed) {
          return cb(new Error('Pool is closed.'));
        }
        if (err) {
          return cb(err);
        }
        this.emit('connection', connection);
        this.emit('acquire', connection);
        return cb(null, connection);
      });
    }
    if (!this.config.waitForConnections) {
      return process.nextTick(() => cb(new Error('No connections available.')));
    }
    if (
      this.config.queueLimit &&
      this._connectionQueue.length >= this.config.queueLimit
    ) {
      return cb(new Error('Queue limit reached.'));
    }
    this.emit('enqueue');
    return this._connectionQueue.push(cb);
  }

  releaseConnection(connection) {
    let cb;
    if (!connection._pool) {
      // The connection has been removed from the pool and is no longer good.
      if (this._connectionQueue.length) {
        cb = this._connectionQueue.shift();
        process.nextTick(this.getConnection.bind(this, cb));
      }
    } else if (this._connectionQueue.length) {
      cb = this._connectionQueue.shift();
      process.nextTick(cb.bind(null, null, connection));
    } else {
      this._freeConnections.push(connection);
      this.emit('release', connection);
    }
  }

  end(cb) {
    this._closed = true;
    if (typeof cb !== 'function') {
      cb = function(err) {
        if (err) {
          throw err;
        }
      };
    }
    let calledBack = false;
    let closedConnections = 0;
    let connection;
    const endCB = function(err) {
      if (calledBack) {
        return;
      }
      if (err || ++closedConnections >= this._allConnections.length) {
        calledBack = true;
        cb(err);
        return;
      }
    }.bind(this);
    if (this._allConnections.length === 0) {
      endCB();
      return;
    }
    for (let i = 0; i < this._allConnections.length; i++) {
      connection = this._allConnections.get(i);
      connection._realEnd(endCB);
    }
  }

  query(sql, values, cb) {
    const cmdQuery = Connection.createQuery(
      sql,
      values,
      cb,
      this.config.connectionConfig
    );
    if (typeof cmdQuery.namedPlaceholders === 'undefined') {
      cmdQuery.namedPlaceholders = this.config.connectionConfig.namedPlaceholders;
    }
    this.getConnection((err, conn) => {
      if (err) {
        if (typeof cmdQuery.onResult === 'function') {
          cmdQuery.onResult(err);
        } else {
          cmdQuery.emit('error', err);
        }
        return;
      }
      try {
        conn.query(cmdQuery).once('end', () => {
          conn.release();
        });
      } catch (e) {
        conn.release();
        throw e;
      }
    });
    return cmdQuery;
  }

  execute(sql, values, cb) {
    // TODO construct execute command first here and pass it to connection.execute
    // so that polymorphic arguments logic is there in one place
    if (typeof values === 'function') {
      cb = values;
      values = [];
    }
    this.getConnection((err, conn) => {
      if (err) {
        return cb(err);
      }
      try {
        conn.execute(sql, values, cb).once('end', () => {
          conn.release();
        });
      } catch (e) {
        conn.release();
        throw e;
      }
    });
  }

  _removeConnection(connection) {
    // Remove connection from all connections
    spliceConnection(this._allConnections, connection);
    // Remove connection from free connections
    spliceConnection(this._freeConnections, connection);
    this.releaseConnection(connection);
  }

  format(sql, values) {
    return mysql.format(
      sql,
      values,
      this.config.connectionConfig.stringifyObjects,
      this.config.connectionConfig.timezone
    );
  }

  escape(value) {
    return mysql.escape(
      value,
      this.config.connectionConfig.stringifyObjects,
      this.config.connectionConfig.timezone
    );
  }

  escapeId(value) {
    return mysql.escapeId(value, false);
  }
}

module.exports = Pool;

}, function(modId) { var map = {"../index.js":1619928528772,"./pool_connection.js":1619928528835,"./connection.js":1619928528773,"../promise":1619928528833}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528835, function(require, module, exports) {


const Connection = require('../index.js').Connection;

class PoolConnection extends Connection {
  constructor(pool, options) {
    super(options);
    this._pool = pool;
    // When a fatal error occurs the connection's protocol ends, which will cause
    // the connection to end as well, thus we only need to watch for the end event
    // and we will be notified of disconnects.
    // REVIEW: Moved to `once`
    this.once('end', () => {
      this._removeFromPool();
    });
    this.once('error', () => {
      this._removeFromPool();
    });
  }

  release() {
    if (!this._pool || this._pool._closed) {
      return;
    }
    this._pool.releaseConnection(this);
  }

  promise(promiseImpl) {
    const PromisePoolConnection = require('../promise').PromisePoolConnection;
    return new PromisePoolConnection(this, promiseImpl);
  }

  end() {
    const err = new Error(
      'Calling conn.end() to release a pooled connection is ' +
        'deprecated. In next version calling conn.end() will be ' +
        'restored to default conn.end() behavior. Use ' +
        'conn.release() instead.'
    );
    this.emit('warn', err);
    // eslint-disable-next-line no-console
    console.warn(err.message);
    this.release();
  }

  destroy() {
    this._removeFromPool();
    super.destroy();
  }

  _removeFromPool() {
    if (!this._pool || this._pool._closed) {
      return;
    }
    const pool = this._pool;
    this._pool = null;
    pool._removeConnection(this);
  }
}

PoolConnection.statementKey = Connection.statementKey;
module.exports = PoolConnection;

// TODO: Remove this when we are removing PoolConnection#end
PoolConnection.prototype._realEnd = Connection.prototype.end;

}, function(modId) { var map = {"../index.js":1619928528772,"../promise":1619928528833}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528836, function(require, module, exports) {


const ConnectionConfig = require('./connection_config.js');

class PoolConfig {
  constructor(options) {
    if (typeof options === 'string') {
      options = ConnectionConfig.parseUrl(options);
    }
    this.connectionConfig = new ConnectionConfig(options);
    this.waitForConnections =
      options.waitForConnections === undefined
        ? true
        : Boolean(options.waitForConnections);
    this.connectionLimit = isNaN(options.connectionLimit)
      ? 10
      : Number(options.connectionLimit);
    this.queueLimit = isNaN(options.queueLimit)
      ? 0
      : Number(options.queueLimit);
  }
}

module.exports = PoolConfig;

}, function(modId) { var map = {"./connection_config.js":1619928528831}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528837, function(require, module, exports) {


const process = require('process');

const Pool = require('./pool.js');
const PoolConfig = require('./pool_config.js');
const EventEmitter = require('events').EventEmitter;

/**
 * Selector
 */
const makeSelector = {
  RR() {
    let index = 0;
    return clusterIds => clusterIds[index++ % clusterIds.length];
  },
  RANDOM() {
    return clusterIds =>
      clusterIds[Math.floor(Math.random() * clusterIds.length)];
  },
  ORDER() {
    return clusterIds => clusterIds[0];
  }
};

class PoolNamespace {
  constructor(cluster, pattern, selector) {
    this._cluster = cluster;
    this._pattern = pattern;
    this._selector = makeSelector[selector]();
  }

  getConnection(cb) {
    const clusterNode = this._getClusterNode();
    if (clusterNode === null) {
      return cb(new Error('Pool does Not exists.'));
    }
    return this._cluster._getConnection(clusterNode, (err, connection) => {
      if (err) {
        return cb(err);
      }
      if (connection === 'retry') {
        return this.getConnection(cb);
      }
      return cb(null, connection);
    });
  }

  _getClusterNode() {
    const foundNodeIds = this._cluster._findNodeIds(this._pattern);
    if (foundNodeIds.length === 0) {
      return null;
    }
    const nodeId =
      foundNodeIds.length === 1
        ? foundNodeIds[0]
        : this._selector(foundNodeIds);
    return this._cluster._getNode(nodeId);
  }
}

class PoolCluster extends EventEmitter {
  constructor(config) {
    super();
    config = config || {};
    this._canRetry =
      typeof config.canRetry === 'undefined' ? true : config.canRetry;
    this._removeNodeErrorCount = config.removeNodeErrorCount || 5;
    this._defaultSelector = config.defaultSelector || 'RR';
    this._closed = false;
    this._lastId = 0;
    this._nodes = {};
    this._serviceableNodeIds = [];
    this._namespaces = {};
    this._findCaches = {};
  }

  of(pattern, selector) {
    pattern = pattern || '*';
    selector = selector || this._defaultSelector;
    selector = selector.toUpperCase();
    if (!makeSelector[selector] === 'undefined') {
      selector = this._defaultSelector;
    }
    const key = pattern + selector;
    if (typeof this._namespaces[key] === 'undefined') {
      this._namespaces[key] = new PoolNamespace(this, pattern, selector);
    }
    return this._namespaces[key];
  }

  add(id, config) {
    if (typeof id === 'object') {
      config = id;
      id = `CLUSTER::${++this._lastId}`;
    }
    if (typeof this._nodes[id] === 'undefined') {
      this._nodes[id] = {
        id: id,
        errorCount: 0,
        pool: new Pool({ config: new PoolConfig(config) })
      };
      this._serviceableNodeIds.push(id);
      this._clearFindCaches();
    }
  }

  getConnection(pattern, selector, cb) {
    let namespace;
    if (typeof pattern === 'function') {
      cb = pattern;
      namespace = this.of();
    } else {
      if (typeof selector === 'function') {
        cb = selector;
        selector = this._defaultSelector;
      }
      namespace = this.of(pattern, selector);
    }
    namespace.getConnection(cb);
  }

  end(callback) {
    const cb =
      callback !== undefined
        ? callback
        : err => {
          if (err) {
            throw err;
          }
        };
    if (this._closed) {
      process.nextTick(cb);
      return;
    }
    this._closed = true;

    let calledBack = false;
    let waitingClose = 0;
    const onEnd = err => {
      if (!calledBack && (err || --waitingClose <= 0)) {
        calledBack = true;
        return cb(err);
      }
    };

    for (const id in this._nodes) {
      waitingClose++;
      this._nodes[id].pool.end(onEnd);
    }
    if (waitingClose === 0) {
      process.nextTick(onEnd);
    }
  }

  _findNodeIds(pattern) {
    if (typeof this._findCaches[pattern] !== 'undefined') {
      return this._findCaches[pattern];
    }
    let foundNodeIds;
    if (pattern === '*') {
      // all
      foundNodeIds = this._serviceableNodeIds;
    } else if (this._serviceableNodeIds.indexOf(pattern) !== -1) {
      // one
      foundNodeIds = [pattern];
    } else {
      // wild matching
      const keyword = pattern.substring(pattern.length - 1, 0);
      foundNodeIds = this._serviceableNodeIds.filter(id =>
        id.startsWith(keyword)
      );
    }
    this._findCaches[pattern] = foundNodeIds;
    return foundNodeIds;
  }

  _getNode(id) {
    return this._nodes[id] || null;
  }

  _increaseErrorCount(node) {
    if (++node.errorCount >= this._removeNodeErrorCount) {
      const index = this._serviceableNodeIds.indexOf(node.id);
      if (index !== -1) {
        this._serviceableNodeIds.splice(index, 1);
        delete this._nodes[node.id];
        this._clearFindCaches();
        node.pool.end();
        this.emit('remove', node.id);
      }
    }
  }

  _decreaseErrorCount(node) {
    if (node.errorCount > 0) {
      --node.errorCount;
    }
  }

  _getConnection(node, cb) {
    node.pool.getConnection((err, connection) => {
      if (err) {
        this._increaseErrorCount(node);
        if (this._canRetry) {
          // REVIEW: this seems wrong?
          this.emit('warn', err);
          // eslint-disable-next-line no-console
          console.warn(`[Error] PoolCluster : ${err}`);
          return cb(null, 'retry');
        }
        return cb(err);
      }
      this._decreaseErrorCount(node);

      connection._clusterId = node.id;
      return cb(null, connection);
    });
  }

  _clearFindCaches() {
    this._findCaches = {};
  }
}

module.exports = PoolCluster;

}, function(modId) { var map = {"./pool.js":1619928528834,"./pool_config.js":1619928528836}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1619928528838, function(require, module, exports) {


const net = require('net');
const EventEmitter = require('events').EventEmitter;

const Connection = require('./connection');
const ConnectionConfig = require('./connection_config');

// TODO: inherit Server from net.Server
class Server extends EventEmitter {
  constructor() {
    super();
    this.connections = [];
    this._server = net.createServer(this._handleConnection.bind(this));
  }

  _handleConnection(socket) {
    const connectionConfig = new ConnectionConfig({
      stream: socket,
      isServer: true
    });
    const connection = new Connection({ config: connectionConfig });
    this.emit('connection', connection);
  }

  listen(port) {
    this._port = port;
    this._server.listen.apply(this._server, arguments);
    return this;
  }

  close(cb) {
    this._server.close(cb);
  }
}

module.exports = Server;

}, function(modId) { var map = {"./connection":1619928528773,"./connection_config":1619928528831}; return __REQUIRE__(map[modId], modId); })
return __REQUIRE__(1619928528772);
})()
//# sourceMappingURL=index.js.map