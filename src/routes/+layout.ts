// The console is one static page that talks to the Go server's API from the
// browser; nginx serves the same index.html for every path under the base.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'always';
