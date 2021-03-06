var util = require('util');
var EventEmitter = require('events').EventEmitter;
var zlib = require('zlib');

// The Client ChildProcessTransport constructor function
function ChildProcessTransport(child, config) {
    // Initialize the Node EventEmitter on this
    EventEmitter.call(this);

    config = config || {};
    this.requests = {};
    this.killChildOnShutdown = typeof(config.killChildOnShutdown) === 'boolean' ? config.killChildOnShutdown : true;
    this.timeout = config.timeout || 30*1000;
    this.sweepTime = config.sweepTime || 1*1000;
    this.sweepInterval = setInterval(this.sweep.bind(this), this.sweepTime);
    this.compressed = config.compressed || false;
    this.compressLength = config.compressLength || 0;
    this.child = child;

    function uncompressedMessageHandler(message) {
        if (message && this.requests[message.id]) {
            this.requests[message.id].callback(message);
            delete this.requests[message.id];
        }
    }

    function compressedMessageHandler(message) {
        if (message && message.charAt(0) === 'z') {
            var buf = new Buffer(message.substring(1), 'base64');
            zlib.gunzip(buf, function(err, uncompressedJSON) {
                if (err) return this.emit('error', err.message);
                var obj = JSON.parse(uncompressedJSON.toString('utf8'));
                if (obj && this.requests[obj.id]) {
                    this.requests[obj.id].callback(obj);
                    delete this.requests[obj.id];
                }
            }.bind(this));
        } else {
            var json = JSON.parse(message);
            if (this.requests[json.id]) {
                this.requests[json.id].callback(json);
                delete this.requests[json.id];
            }
        }
    }
    this.child.on('message', this.compressed ? compressedMessageHandler.bind(this) : uncompressedMessageHandler.bind(this));
    this.child.on('exit', function(code, signal) {
        this.emit('exit', code, signal);
        this.shutdown();
    }.bind(this));
    this.child.on('error', function(e) {
        this.emit('error', e);
        this.shutdown();
    }.bind(this));

    return this;
}

// Attach the EventEmitter prototype as the ChildProcessTransport's prototype's prototype
util.inherits(ChildProcessTransport, EventEmitter);

// The request logic is relatively straightforward, given the request
// body and callback function, register the request with the requests
// object, then if there is a valid connection at the moment, send the
// request to the server with a null terminator attached. This ordering
// guarantees that requests called during a connection issue won't be
// lost while a connection is re-established.
ChildProcessTransport.prototype.request = function request(body, callback) {
    this.requests[body.id] = {
        callback: callback,
        body: body,
        timestamp: Date.now()
    };
    if (this.child) {
        if (this.compressed) {
            var jsonStr = JSON.stringify(body);
            if (!this.compressLength || jsonStr.length > this.compressLength) {
                zlib.gzip(new Buffer(JSON.stringify(body)), function(err, compressedJSON) {
                    if (err) return this.emit('error', err.message);
                    this.child.send('z' + compressedJSON.toString('base64'));
                }.bind(this));
            } else {
                this.child.send(jsonStr);
            }
        } else {
            this.child.send(body);
        }
    }
};

// The sweep function looks at the timestamps for each request, and any
// request that is longer lived than the timeout (default 2 min) will be
// culled and assumed lost.
ChildProcessTransport.prototype.sweep = function sweep() {
    var now = Date.now();
    var cannedRequests = {};
    for(var key in this.requests) {
        if(this.requests[key].timestamp && this.requests[key].timestamp + this.timeout < now) {
            this.requests[key].callback({ error: 'Request Timed Out' });
            cannedRequests[key] = this.requests[key];
            delete this.requests[key];
        }
    }
    this.emit('sweep', cannedRequests);
};

// When shutting down the client connection, the sweep is turned off, the
// requests are removed, the number of allowed retries is set to zero, the
// connection is ended, and a callback, if any, is called.
ChildProcessTransport.prototype.shutdown = function shutdown(done) {
    clearInterval(this.sweepInterval);
    this.requests = {};
    if(this.killChildOnShutdown) {
        if(this.child) this.child.kill();
        delete this.child;
    } else {
        this.child.disconnect();
    }
    this.emit('shutdown');
    if(done instanceof Function) done();
};

// Export the client ChildProcessTransport
module.exports = ChildProcessTransport;
