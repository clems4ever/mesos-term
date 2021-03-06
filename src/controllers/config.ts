import * as Express from 'express';
import { Request } from '../express_helpers';
import { env } from '../env_vars';
import { isSuperAdmin } from '../authorizations';

export default function (req: Request, res: Express.Response) {
    const can_grant_access = env.AUTHORIZATIONS_ENABLED;

    res.send({ can_grant_access });
}
