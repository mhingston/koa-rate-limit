const cluster = require('cluster');
const Netmask = require('netmask');
const uuid  = require('uuid');
const STATUS =
{
    FORBIDDEN: 403,
    TOO_MANY_REQUESTS: 429
};
const rules = [];

const addRule = ({method, path, max, interval, whitelist, blacklist}) =>
{
    rules.push(
    {
        method,
        path,
        max,
        interval,
        whitelist,
        blacklist,
        clients: []
    });
}

const findRule = (properties) =>
{
    const keys = Object.keys(properties);
    const required = keys.length;

    for(const rule of rules)
    {
        let count = 0;

        for(const key of keys)
        {
            if(rule[key] === properties[key])
            {
                count++;
            }
        };

        if(count === required)
        {
            return rule;
        }
    }
}

const rateLimit = ({interval, max, whitelist, blacklist, logger}) =>
{
    interval = interval || 5 * 60 * 1000;
    max = max || 10;
    whitelist = whitelist || [];
    whitelist = whitelist.map((ipAddr) => new Netmask(ipAddr));
    blacklist = blacklist || [];
    blacklist = blacklist.map((ipAddr) => new Netmask(ipAddr));

    if(typeof logger === 'function')
    {
        logger =
        {
            log: logger
        }
    }

    else if(logger)
    {
        logger =
        {
            log: (...args) => console.log(...args)
        }
    }

    else
    {
        logger = 
        {
            log: () => {}
        }
    }

    const respond = ({id, status, rule, client, action}) =>
    {
        const response =
        {
            rateLimit:
            {
                result:
                {
                    id: id,
                    status: status
                }
            }
        };

        if(action)
        {
            response.rateLimit.result.action = action;
        }

        else
        {
            response.rateLimit.result.headers =
            {
                'X-RateLimit-Limit': rule.max,
                'X-RateLimit-Remaining': rule.max - client.count,
                'X-RateLimit-Reset': new Date(client.timestamp + rule.interval).toISOString()
            }
        }

        return response;
    };

    const removeClient = (rule, client) =>
    {
        clearTimeout(client.timer);

        for(let i = rule.clients.length-1; i >= 0; i--)
        {
            if(rule.clients[i] === client)
            {
                logger.log('info', `Removed rate limiting for: ${client.ip} [${client.method}] ${client.path}.`);
                rule.clients.splice(i, 1);
                break;
            }
        }
    };

    const handleQuery = ({id, ip, method, path, timestamp}) =>
    {
        let status;
        let rule = findRule({method, path});

        if(!rule)
        {
            addRule({method, path, max, interval, whitelist, blacklist});
            rule = rules[rules.length-1];
        }

        let client;
        let found = false;

        for(client of rule.clients)
        {
            if(client.ip === ip)
            {
                found = true;
                break;
            }
        }

        if(!found)
        {
            client = {ip, count: 0, timestamp};
            client.timer = setTimeout(removeClient.bind(this, rule, client), interval);
            rule.clients.push(client);
        }

        for(const goodIP of rule.whitelist)
        {
            if(goodIP.contains(ip))
            {
                return respond({id, action: 'whitelist'});
            }
        }

        for(const badIP of rule.blacklist)
        {
            if(badIP.contains(ip))
            {
                return respond({id, action: 'blacklist'});
            }
        }

        if(client.count+1 <= rule.max)
        {
            client.count++;
            return respond({id, rule, client});
        }

        return respond({id, status: STATUS.TOO_MANY_REQUESTS, rule, client});
    };

    const handleResponse = (ctx, next, message) =>
    {
        if(message.rateLimit.result.action)
        {
            if(message.rateLimit.result.action === 'whitelist')
            {
                return next();
            }

            else if(message.rateLimit.result.action === 'blacklist')
            {
                ctx.throw(STATUS.FORBIDDEN);
                return;
            }
        }

        if(message.rateLimit.result.status)
        {
            ctx.status = message.rateLimit.result.status;
        }

        if(message.rateLimit.result.hasOwnProperty('headers'))
        {
            const headers = message.rateLimit.result.headers;
            const keys = Object.keys(message.rateLimit.result.headers);
            keys.forEach((header) => ctx.set(header, headers[header]));
        }

        if(ctx.status === STATUS.TOO_MANY_REQUESTS)
        {
            let waitTime = (new Date(message.rateLimit.result.headers['X-RateLimit-Reset']) - new Date()) / 1000;
            let units = 'second(s)';
            
            if(waitTime >= 60)
            {
                waitTime = waitTime / 60;
                units = 'minutes';
            }

            if(waitTime >= 60)
            {
                waitTime = waitTime / 60;
                units = 'hour(s)';
            }

            logger.log('info', `Rate limiting: ${ctx.ip} from accessing: [${ctx.method}] ${ctx.path}.`);
            ctx.body = `Your request has been rate limited. Please try again in ${Math.round(waitTime)} ${units}`;
            return;
        }

        return next();
    };

    if(cluster.isMaster)
    {
        cluster.on('message', (worker, message) =>
        {
            if(message.hasOwnProperty('rateLimit') && message.rateLimit.hasOwnProperty('query'))
            {
                const query = message.rateLimit.query;
                const response = handleQuery(message.rateLimit.query);
                worker.send(response);
            }
        });
    }

    return (ctx, next) =>
    {
        return new Promise((resolve, reject) =>
        {
            if(cluster.isMaster)
            {
                if(!findRule(
                {
                    method: ctx.method,
                    path: ctx.path
                }))
                {
                    addRule(
                    {
                        method: ctx.method,
                        path: ctx.path,
                        max,
                        interval,
                        whitelist,
                        blacklist
                    });
                }

                const response = handleQuery({ip: ctx.ip, method: ctx.method, path: ctx.path, timestamp: new Date().getTime()});
                return resolve(handleResponse(ctx, next, response));
            }

            const id = uuid.v1();

            process.send(
            {
                rateLimit:
                {
                    query:
                    {
                        id,
                        ip: ctx.ip,
                        method: ctx.method,
                        path: ctx.path,
                        timestamp: new Date().getTime()
                    }
                }
            });

            process.once('message', function handleMessage(message)
            {
                if(message.hasOwnProperty('rateLimit') && message.rateLimit.hasOwnProperty('result'))
                {
                    if(message.rateLimit.result.id === id)
                    {
                        return resolve(handleResponse(ctx, next, message));
                    }
                }
            });
        });
    };
}

module.exports = rateLimit