import Express = require('express');
import Constants = require('../constants');
import { getTaskInfo, Task } from '../mesos';
import { getAdminsByTaskId, getUserByTaskId, getLogger } from '../express_helpers';
import { isUserAllowedToDebug } from '../authorizations';
import { env } from '../env_vars';

function renderTerminal(req: Express.Request, res: Express.Response, task: Task) {
  const task_id = req.params.task_id;
  getLogger(req).request(req, task_id);

  res.render('index', {
    task_id: task_id,
    user: task.user || '(no user)'
  });
}

export function authenticated(req: Express.Request, res: Express.Response) {
  if (req.url == '/favicon.ico') {
    res.status(404);
    return;
  }

  const taskId = req.params.task_id;

  getTaskInfo(taskId)
    .then(function(task: Task) {
      if (Constants.DEBUG_ALLOWED_TO_KEY in task.labels) {
        const adminsByTaskId = getAdminsByTaskId(req);
        adminsByTaskId[taskId] = task.labels[Constants.DEBUG_ALLOWED_TO_KEY].split(',');
      }

      if (task.user) {
        const userByTaskId = getUserByTaskId(req);
        userByTaskId[taskId] = task.user;
      }

      isUserAllowedToDebug(req, res, function() {
        renderTerminal(req, res, task);
      });
    })
    .catch(function(err: Error) {
      res.send('Error while retrieving task labels.');
      console.error('Error while retrieving task labels %s', err);
    });
}

export function anonymous(req: Express.Request, res: Express.Response) {
  const taskId = req.params.task_id;
  getTaskInfo(taskId)
    .then(function(task: Task) {
      renderTerminal(req, res, task);
    })
    .catch(function(err: Error) {
      res.send('Error while retrieving task labels.');
      console.error('Error while retrieving task labels %s', err);
    });
}
