/**
 * CloudFront Function (viewer request) — routes SPA traffic and S3 listing
 * through one distribution.
 *
 * Why this exists: the dashboard discovers runs by calling S3's ListObjectsV2
 * REST API, which is a GET on the bucket root with query strings:
 *
 *     GET /?list-type=2&prefix=runs/&delimiter=/
 *
 * The obvious CloudFront setup breaks that. Setting a Default Root Object makes
 * CloudFront answer `/` with index.html *before* the origin ever sees the query
 * string, so the listing call silently returns the SPA's own HTML.
 *
 * So: do NOT set a Default Root Object on the distribution. Attach this function
 * instead. It appends index.html only for requests that are actually navigations,
 * and leaves anything carrying `list-type` untouched.
 *
 * Deploy: infra/deploy.sh publishes this and associates it with the default
 * cache behaviour. The distribution must also forward query strings to the
 * origin (the deploy script uses the AllViewer origin request policy).
 */

function handler(event) {
  var request = event.request;

  // An S3 listing call — pass straight through to the origin.
  if (request.querystring && request.querystring['list-type']) {
    return request;
  }

  var uri = request.uri;

  // Directory-style request: serve that directory's index.html. This covers the
  // SPA root and every hosted Allure report, which are directories too.
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // Extensionless path: treat as a directory and redirect-by-rewrite.
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }

  return request;
}
