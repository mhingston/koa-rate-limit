# koa-rate-limit

Simple rate limiting for [Koa](https://github.com/koajs/koa), supports clustered apps, blacklisting and whitelisting.

# Install
> npm install mhingston/koa-rate-limit

# Usage

	const rateLimit = require('koa-rate-limit');

Setup per-route middleware for rate limiting:

	router.get('/', rateLimit({interval: 5 * 60 * 1000}), (ctx, next) =>
	{
		ctx.body = 'Hello World!';
	});

# Configuration

* `interval` {Integer} The rate limiting window (in milliseconds).
* `max` {Integer} The maximum number of requests before rate limiting is applied.
* `whitelist` {String[]} An array of default IP addresses to always allow (you can use [CIDR notation](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing#CIDR_notation)).
* `blacklist` {String[]} An array of default IP addresses to always deny (you can use [CIDR notation](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing#CIDR_notation)).