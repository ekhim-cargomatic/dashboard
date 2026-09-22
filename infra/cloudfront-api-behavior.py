#!/usr/bin/env python3
"""
Route /api/* on the dashboard's CloudFront distribution to the Notion HTTP API.

Why this exists rather than a Lambda Function URL: this AWS Organization denies
lambda:InvokeFunctionUrl, so a Function URL returns 403 to everyone — including
requests signed with administrator credentials — and the function is never
reached. API Gateway is not covered by that guardrail.

Putting the API behind the distribution the dashboard already uses is also the
better shape: the browser call becomes same-origin, so CORS stops being involved
at all, and the endpoint is only reachable through the dashboard's domain.

Idempotent — adds the origin and the behavior only if they are absent.

    python3 infra/cloudfront-api-behavior.py <distribution-id> <api-domain>
"""

import json
import subprocess
import sys

ORIGIN_ID = "notion-api"

# AWS managed policies. CachingDisabled because nothing here is cacheable, and
# AllViewerExceptHostHeader because API Gateway rejects a forwarded Host header.
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"


def aws(*args: str) -> str:
    result = subprocess.run(["aws", *args], capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"aws {' '.join(args[:3])} failed:\n{result.stderr.strip()}")
    return result.stdout


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip())
    dist_id, api_domain = sys.argv[1], sys.argv[2]

    raw = json.loads(aws("cloudfront", "get-distribution-config", "--id", dist_id, "--output", "json"))
    etag, config = raw["ETag"], raw["DistributionConfig"]

    changed = False

    origins = config["Origins"]
    if any(o["Id"] == ORIGIN_ID for o in origins["Items"]):
        print(f"origin {ORIGIN_ID}: already present")
    else:
        origins["Items"].append({
            "Id": ORIGIN_ID,
            "DomainName": api_domain,
            "OriginPath": "",
            "CustomHeaders": {"Quantity": 0},
            "CustomOriginConfig": {
                "HTTPPort": 80,
                "HTTPSPort": 443,
                "OriginProtocolPolicy": "https-only",
                "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
                "OriginReadTimeout": 30,
                "OriginKeepaliveTimeout": 5,
            },
            "ConnectionAttempts": 3,
            "ConnectionTimeout": 10,
            "OriginShield": {"Enabled": False},
            "OriginAccessControlId": "",
        })
        origins["Quantity"] = len(origins["Items"])
        changed = True
        print(f"origin {ORIGIN_ID}: added -> {api_domain}")

    behaviors = config.setdefault("CacheBehaviors", {"Quantity": 0, "Items": []})
    behaviors.setdefault("Items", [])
    if any(b["PathPattern"] == "/api/*" for b in behaviors["Items"]):
        print("behavior /api/*: already present")
    else:
        behaviors["Items"].append({
            "PathPattern": "/api/*",
            "TargetOriginId": ORIGIN_ID,
            "ViewerProtocolPolicy": "https-only",
            # POST with a body has to reach the origin; only GET/HEAD are cacheable
            # and the cache policy disables even those.
            "AllowedMethods": {
                "Quantity": 7,
                "Items": ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS", "DELETE"],
                "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
            },
            "Compress": True,
            "CachePolicyId": CACHING_DISABLED,
            "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
            "SmoothStreaming": False,
            "FieldLevelEncryptionId": "",
            "TrustedSigners": {"Enabled": False, "Quantity": 0},
            "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
            "LambdaFunctionAssociations": {"Quantity": 0},
            "FunctionAssociations": {"Quantity": 0},
        })
        behaviors["Quantity"] = len(behaviors["Items"])
        changed = True
        print("behavior /api/*: added")

    if not changed:
        print("nothing to do")
        return

    with open("/tmp/cf-dist-config.json", "w") as handle:
        json.dump(config, handle)

    aws(
        "cloudfront", "update-distribution",
        "--id", dist_id,
        "--if-match", etag,
        "--distribution-config", "file:///tmp/cf-dist-config.json",
        "--query", "Distribution.Status",
        "--output", "text",
    )
    print("distribution updated — propagation takes a few minutes")


if __name__ == "__main__":
    main()
