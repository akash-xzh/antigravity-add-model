"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUiMitmToken = getUiMitmToken;
exports.guardLoopbackRequest = guardLoopbackRequest;
exports.languageServerModelsUrl = languageServerModelsUrl;
exports.authenticatedGoogleFileUrl = authenticatedGoogleFileUrl;
const node_crypto_1 = require("node:crypto");
const UI_MITM_TOKEN = (0, node_crypto_1.randomBytes)(24).toString('hex');
/** Per-process token authenticating Electron's HTTPS->HTTP /main.js redirect. */
function getUiMitmToken() {
    return UI_MITM_TOKEN;
}
function validPort(port) {
    return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;
}
function loopbackOrigins(port, protocols) {
    return protocols.flatMap((protocol) => [`${protocol}//127.0.0.1:${port}`, `${protocol}//localhost:${port}`]);
}
function parseOrigin(value) {
    if (!value)
        return undefined;
    try {
        return new URL(value).origin;
    }
    catch {
        return undefined;
    }
}
/** Native language-server callers omit Origin; browser callers must use an owned origin. */
function guardLoopbackRequest(req, res, languageServerPort) {
    const port = req.socket.localPort;
    const duplicate = ['host', 'origin', 'sec-fetch-site', 'referer'].some((name) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1);
    const allowedOrigins = validPort(port) ? loopbackOrigins(port, ['http:']) : [];
    if (validPort(languageServerPort))
        allowedOrigins.push(...loopbackOrigins(languageServerPort, ['http:', 'https:']));
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string'
        ? req.headers['sec-fetch-site'].trim().toLowerCase()
        : undefined;
    const refererOrigin = parseOrigin(typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
    // Electron redirects `<script src="/main.js">` from `https://127.0.0.1:<lsPort>` to
    // `http://127.0.0.1:<proxyPort>/_ui/main.js?t=<token>`. Because that is an HTTPS->HTTP
    // downgrade on a no-cors script, Chromium sends `Sec-Fetch-Site: cross-site` with no
    // `Origin` and strips `Referer`. Authenticate that exact redirect with the per-process token
    // while keeping all unauthenticated cross-site requests blocked.
    const isAuthorizedMitmScript = (() => {
        if (req.method !== 'GET' || !req.url?.startsWith('/_ui/main.js'))
            return false;
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const token = parsed.searchParams.get('t') || '';
            if (parsed.pathname !== '/_ui/main.js' || token.length !== UI_MITM_TOKEN.length)
                return false;
            return (0, node_crypto_1.timingSafeEqual)(Buffer.from(token, 'utf8'), Buffer.from(UI_MITM_TOKEN, 'utf8'));
        }
        catch {
            return false;
        }
    })();
    // Reject cross-site browser fetches (including GET requests without Origin) unless authenticated
    // as an owned loopback origin (e.g. Electron renderer https://127.0.0.1:<lsPort> -> http proxy).
    const crossSiteBlocked = secFetchSite === 'cross-site' &&
        !isAuthorizedMitmScript &&
        !(origin !== undefined && allowedOrigins.includes(origin)) &&
        !(origin === undefined && refererOrigin !== undefined && allowedOrigins.includes(refererOrigin));
    if (duplicate ||
        crossSiteBlocked ||
        !validPort(port) ||
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || '') ||
        (origin !== undefined && !allowedOrigins.includes(origin))) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Service is available only at its loopback origin' }));
        return false;
    }
    return true;
}
/** The desktop supplies its current LS port, never a port learned from an HTTP caller. */
function languageServerModelsUrl(value, port) {
    if (!validPort(port))
        return undefined;
    try {
        const url = new URL(value);
        if (value !== url.href ||
            !loopbackOrigins(port, ['http:', 'https:']).includes(url.origin) ||
            ![
                '/LanguageServerService/GetAvailableModels',
                '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
            ].includes(url.pathname) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash)
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
/** Incoming Google credentials may only accompany HTTPS downloads from Google API hosts. */
function authenticatedGoogleFileUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' ||
            (url.hostname !== 'googleapis.com' && !url.hostname.endsWith('.googleapis.com')) ||
            url.username ||
            url.password ||
            url.hash ||
            (url.port && url.port !== '443'))
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=loopbackSecurity.js.map