"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extensionAuthorities = void 0;
exports.parseLoopbackAuthorityOrigin = parseLoopbackAuthorityOrigin;
exports.registerCustomSchemes = registerCustomSchemes;
exports.registerCustomSchemeHandlers = registerCustomSchemeHandlers;
const electron_1 = require("electron");
// A map of extension authority -> original URL (http://localhost:<port>)
// The authority is usually a hash of unique extension identifiers
// like extension ID + port + project ID. An extension running on localhost:<port>
// is then exposed on plugin://<authority>.
exports.extensionAuthorities = new Map();
const LOOPBACK_AUTHORITY_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i;
function parseLoopbackAuthorityOrigin(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!LOOPBACK_AUTHORITY_RE.test(trimmed))
        return null;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'http:')
        return null;
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
        return null;
    if (parsed.username || parsed.password)
        return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash)
        return null;
    const port = Number(parsed.port || '80');
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return null;
    return parsed.origin;
}
function registerCustomSchemes() {
    electron_1.protocol.registerSchemesAsPrivileged([
        {
            scheme: 'plugin',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
                allowServiceWorkers: true,
                codeCache: true,
            },
        },
    ]);
}
function registerCustomSchemeHandlers() {
    // Handle custom scheme for UI extensions
    electron_1.protocol.handle('plugin', async (request) => {
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return new Response(null, { status: 400 });
        }
        const authority = url.hostname;
        const originalHost = exports.extensionAuthorities.get(authority);
        if (!originalHost) {
            return new Response(null, { status: 404 });
        }
        const validatedOrigin = parseLoopbackAuthorityOrigin(originalHost);
        if (!validatedOrigin) {
            return new Response(null, { status: 403 });
        }
        let targetUrl;
        try {
            targetUrl = new URL(url.pathname + url.search, validatedOrigin);
        }
        catch {
            return new Response(null, { status: 400 });
        }
        if (targetUrl.origin !== validatedOrigin) {
            return new Response(null, { status: 403 });
        }
        try {
            const fetchOptions = {
                method: request.method,
                headers: request.headers,
                body: request.body,
            };
            if (request.body) {
                // Required by Electron's net.fetch when the body is a stream
                fetchOptions.duplex = 'half';
            }
            const response = await electron_1.net.fetch(targetUrl.toString(), fetchOptions);
            return response;
        }
        catch (err) {
            console.error(`Failed to proxy request to ${targetUrl}:`, err);
            return new Response(null, { status: 500 });
        }
    });
}
//# sourceMappingURL=customScheme.js.map