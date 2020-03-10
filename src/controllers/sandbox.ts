import Express = require('express');
import {
    browseSandbox, getTaskInfo, getMesosSlaveState, readSandboxFile,
    downloadSandboxFileAsStream, downloadSandboxDirectory, TaskInfo, MesosAgentNotFoundError,
    TaskNotFoundError, FileNotFoundError
} from '../mesos';
import { env } from '../env_vars';
import * as Moment from 'moment';
import { CheckTaskAuthorization, UnauthorizedAccessError } from '../authorizations';
import { Request } from '../express_helpers';

interface SandboxDescriptor {
    agentURL: string;
    workDir: string;
    slaveID: string;
    frameworkID: string;
    containerID: string;
    task: TaskInfo;
    last_status: 'TASK_STARTING' | 'TASK_RUNNING' | 'TASK_KILLED' | 'UNKNOWN';
}

function cacheSandboxDescriptor(fetcher: (taskID: string) => Promise<SandboxDescriptor>) {
    const cache: {
        [taskID: string]: {
            expireAt: Date;
            locator: SandboxDescriptor;
        }
    } = {};

    setInterval(clearExpiredEntries, 1000);

    function clearExpiredEntries() {
        const expiredTaskIDs = [] as string[];
        for (const taskID in cache) {
            if (cache[taskID].expireAt < new Date()) {
                expiredTaskIDs.push(taskID);
            }
        }
        for (const i in expiredTaskIDs) {
            delete cache[expiredTaskIDs[i]];
        }
    }

    return async (taskID: string) => {
        if (taskID in cache && cache[taskID].expireAt > new Date()) {
            return cache[taskID].locator;
        }

        const res = await fetcher(taskID);
        cache[taskID] = {
            expireAt: Moment(new Date()).add(10, 'second').toDate(),
            locator: res,
        };
        return res;
    };
}



const sandboxCache = cacheSandboxDescriptor(async (taskID) => {
    const taskInfo = await getTaskInfo(taskID);
    const slaveState = await getMesosSlaveState(taskInfo.agent_url);
    const status = (taskInfo.statuses.length > 0) ? taskInfo.statuses[taskInfo.statuses.length - 1] : 'UNKNOWN';
    return {
        agentURL: taskInfo.agent_url,
        workDir: slaveState.flags.work_dir,
        slaveID: slaveState.id,
        frameworkID: taskInfo.framework_id,
        containerID: taskInfo.container_id,
        task: taskInfo,
        last_status: status,
    };
});

export default function (app: Express.Application) {
    app.get('/api/sandbox/*', async function (req: Request, res: Express.Response, next: Express.NextFunction) {
        try {
            if (env.AUTHORIZATIONS_ENABLED && !env.AUTHORIZE_ALL_SANDBOXES) {
                const sandbox = await sandboxCache(req.query.taskID);
                await CheckTaskAuthorization(req, sandbox.task, req.query.access_token);
            }
        }
        catch (err) {
            console.error(`Cannot authorize user ${req.user.cn} to access to sandbox of task ${req.query.taskID}`, err);
            if (err instanceof MesosAgentNotFoundError) {
                res.status(400);
                res.send('Mesos agent not found');
                return;
            }
            else if (err instanceof UnauthorizedAccessError) {
                res.status(403);
                res.send('Unauthorized');
                return;
            }
            else if (err instanceof TaskNotFoundError) {
                res.status(404);
                res.send('Task not found');
                return;
            }
            res.status(500);
            res.send();
        }

        await next();
    });

    app.get('/api/sandbox/browse', async function (req: Express.Request, res: Express.Response) {
        try {
            const sandbox = await sandboxCache(req.query.taskID);
            const files = await browseSandbox(sandbox.agentURL, sandbox.workDir, sandbox.slaveID, sandbox.frameworkID,
                req.query.taskID, sandbox.containerID, req.query.path);
            res.send(files);
        }
        catch (err) {
            console.error(`Cannot browse files in ${req.query.path} from sandbox of task ${req.query.taskID}`, err);
            if (err instanceof MesosAgentNotFoundError) {
                res.status(400);
                res.send('Mesos agent not found');
                return;
            }
            else if (err instanceof FileNotFoundError) {
                res.status(404);
                res.send('File not found');
                return;
            }
            else if (err instanceof UnauthorizedAccessError) {
                res.status(403);
                res.send('Unauthorized');
                return;
            }
            else if (err instanceof TaskNotFoundError) {
                res.status(404);
                res.send('Task not found');
                return;
            }
            res.status(503);
            res.send();
            return;
        }
    });

    app.get('/api/sandbox/read', async function (req: Express.Request, res: Express.Response) {
        try {
            const sandbox = await sandboxCache(req.query.taskID);
            const files = await readSandboxFile(sandbox.agentURL, sandbox.workDir, sandbox.slaveID, sandbox.frameworkID,
                req.query.taskID, sandbox.containerID, req.query.path, req.query.offset, req.query.size);
            if (!(sandbox.last_status === 'TASK_RUNNING' || sandbox.last_status === 'TASK_STARTING')) {
                files.eof = true;
            }
            res.send(files);
        }
        catch (err) {
            console.error(`Cannot read file ${req.query.path} from sandbox of task ${req.query.taskID}`, err);
            if (err instanceof MesosAgentNotFoundError) {
                res.status(400);
                res.send('Mesos agent not found');
                return;
            }
            else if (err instanceof FileNotFoundError) {
                res.status(404);
                res.send('File not found');
                return;
            }
            else if (err instanceof UnauthorizedAccessError) {
                res.status(403);
                res.send('Unauthorized');
                return;
            }
            else if (err instanceof TaskNotFoundError) {
                res.status(404);
                res.send('Task not found');
                return;
            }
            res.status(503);
            res.send();
            return;
        }
    });

    app.get('/api/sandbox/download', async function (req: Express.Request, res: Express.Response) {
        try {
            const sandbox = await sandboxCache(req.query.taskID);
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment; filename=' + req.query.filename);

            if (req.query.directory === 'true') {
                await downloadSandboxDirectory(sandbox.agentURL, sandbox.workDir, sandbox.slaveID,
                    sandbox.frameworkID, req.query.taskID, sandbox.containerID, req.query.path, res);
            }
            else {
                await downloadSandboxFileAsStream(sandbox.agentURL, sandbox.workDir, sandbox.slaveID,
                    sandbox.frameworkID, req.query.taskID, sandbox.containerID, req.query.path, res);
            }
            res.end();
        }
        catch (err) {
            console.error(`Cannot download file(s) ${req.query.path} from sandbox of task ${req.query.taskID}`, err);
            if (err instanceof MesosAgentNotFoundError) {
                res.status(400);
                res.send('Mesos agent not found');
                return;
            }
            else if (err instanceof FileNotFoundError) {
                res.status(404);
                res.send('File not found');
                return;
            }
            else if (err instanceof UnauthorizedAccessError) {
                res.status(403);
                res.send('Unauthorized');
                return;
            }
            else if (err instanceof TaskNotFoundError) {
                res.status(404);
                res.send('Task not found');
                return;
            }
            res.status(503);
            res.send();
            return;
        }
    });
}