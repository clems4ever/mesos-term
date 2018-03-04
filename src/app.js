var express = require('express');
var app = express();
var expressWs = require('express-ws')(app);
var os = require('os');
var pty = require('node-pty');
var path = require('path');
var passport = require('passport');
var LdapStrategy = require('passport-ldapauth');
var basicAuth = require('basic-auth');
var session = require('express-session')
var terminals = {};
var logs = {};

function getOrExit(var_name) {
  var v = process.env[var_name];
  if(v) return v;
 
  console.log(`${var_name} env var must be provided`);
  process.exit(1);
}

function protectWithBasicAuth(req, res, next) {
  var credentials = basicAuth(req);
  if(credentials) {
    next()
  }
  else {
    res.status(401);
    res.header('WWW-Authenticate', 'Basic realm="must be authenticated"');
    res.send('Unauthorized');
  }
}

function intersection(array1, array2) {
  return array1.filter(function(n) {
    return array2.indexOf(n) !== -1;
  });
}

function isUserAllowed(groups) {
   return function(req, res, next) {
     if(!groups || intersection(req.user.memberOf, groups).length > 0)
       next();
     else {
       console.error('User "%s" is not in authorized groups', req.user.cn);
       res.status(403);
       res.send('Unauthorized');
     }
   } 
}

var MESOS_TASK_EXEC_PATH = getOrExit('MESOS_TASK_EXEC_PATH');
var SESSION_SECRET = getOrExit('SESSION_SECRET');
var LDAP_URL = getOrExit('LDAP_URL');
var LDAP_BASE_DN = getOrExit('LDAP_BASE_DN');
var LDAP_USER = getOrExit('LDAP_USER');
var LDAP_PASSWORD = getOrExit('LDAP_PASSWORD');
var LDAP_ALLOWED_GROUPS = process.env['LDAP_ALLOWED_GROUPS']
var allowed_groups;

if(!LDAP_ALLOWED_GROUPS) {
  console.log('All users are allowed to connect to containers');
}
else {
  allowed_groups = LDAP_ALLOWED_GROUPS.split(';');
  console.log('Only users from following groups can log in containers:\n%s', allowed_groups.join("\n"));
}

var OPTS = {
  server: {
    url: LDAP_URL,
    bindDN: LDAP_USER,
    bindCredentials: LDAP_PASSWORD,
    searchBase: LDAP_BASE_DN,
    searchFilter: '(&(cn={{username}})(objectClass=user))'
  },
  credentialsLookup: basicAuth
};


passport.use(new LdapStrategy(OPTS));
app.use(express.static(__dirname + '/public_html'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '/views'));
app.use(passport.initialize());
app.use(protectWithBasicAuth);
app.use(passport.authenticate('ldapauth', {session: true}));
app.use(isUserAllowed(allowed_groups));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
}));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

app.get('/', function(req, res) {
  res.send('Please provide a task ID like /mytask-id');
});

app.get('/ping', function(req, res) {
  res.send('pong');
});

app.get('/:task_id', function(req, res) {
  if(req.url == '/favicon.ico') {
    res.status(404);
    return;
  }

  const task_id = req.params.task_id;
  console.log('User "%s" has requested a session in container "%s"', req.user.cn, task_id);
  res.render('index', {
    task_id: task_id
  });
});

app.post('/terminals/:task_id', function(req, res) {
  const task_id = req.params.task_id;
  if(!task_id) {
    res.send('You must provide a valid task id.');
    return;
  }
  const term = pty.spawn('python3', [MESOS_TASK_EXEC_PATH, task_id], {
        name: 'mesos-task-exec',
        cwd: process.env.PWD,
        env: process.env
      });

  console.log('User "%s" has opened a session in container "%s" (pid=%s)', req.user.cn, task_id, term.pid);
  terminals[term.pid] = term;
  logs[term.pid] = '';
  term.on('data', function(data) {
    logs[term.pid] += data;
  });
  res.send(term.pid.toString());
  res.end();
});

app.post('/terminals/:pid/size', function (req, res) {
  var pid = parseInt(req.params.pid),
      cols = parseInt(req.query.cols),
      rows = parseInt(req.query.rows),
      term = terminals[pid];

  term.resize(cols, rows);
  console.log('Resized terminal ' + pid + ' to ' + cols + ' cols and ' + rows + ' rows.');
  res.end();
});

app.ws('/terminals/:pid', function (ws, req) {
  var term = terminals[parseInt(req.params.pid)];
  console.log('User "%s" is connected to terminal %s', req.user.cn, term.pid);
  ws.send(logs[term.pid]);

  term.on('data', function(data) {
    try {
      ws.send(data);
    } catch (ex) {
      // The WebSocket is not open, ignore
    }
  });
  ws.on('message', function(msg) {
    term.write(msg);
  });
  ws.on('close', function () {
    term.kill();
    console.log('User "%s" is diconnected from terminal %s', req.user.cn, term.pid);
    // Clean things up
    delete terminals[term.pid];
    delete logs[term.pid];
  });
});

var port = process.env.PORT || 3000,
    host = os.platform() === 'win32' ? '127.0.0.1' : '0.0.0.0';

console.log('App listening to http://' + host + ':' + port);
app.listen(port, host);
