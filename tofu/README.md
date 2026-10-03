# infrastructure

proxmox.computer is a static export served from a private S3 bucket through
CloudFront, with DNS at Cloudflare. CloudFront isn't only the cdn: it gives
the site https, and the wizard needs that, because browsers only offer the
WebCrypto its vault is built on to a secure origin.

```
visitor ──https──▶ CloudFront ──origin access control──▶ S3 (private)
             ▲        │ viewer-request function: /setup/ → /setup/index.html
             │        │ response headers: csp, hsts, nosniff, frame deny …
Cloudflare: proxmox.computer CNAME → d….cloudfront.net (dns only)
```

| path | what |
| --- | --- |
| `*.tf` | the site stack: bucket, CloudFront, its ACM certificate (us-east-1), the Cloudflare records |
| `functions/viewer-request.js` | the CloudFront Function mapping routes to their `index.html`; unit-tested by `npm test` |
| `tests/` | `tofu test` against mocked providers: asserts the bucket is private, https is enforced, the headers, the dns |
| `bootstrap/` | run once by hand: the state bucket and the role github assumes to deploy |

The pipeline is `.github/workflows/deploy.yml`. Every push and pull request
runs lint, typecheck, tests and the build, plus `tofu fmt`/`validate`/`test`
for both stacks. On `main` it then applies the site stack, uploads the
export and invalidates the CloudFront cache, and smoke-tests the live site.

## one-time setup

1. **Bootstrap** with admin credentials for the aws account:

   ```sh
   cd tofu/bootstrap
   tofu init
   tofu apply        # -var create_github_oidc_provider=false if the account already has github's provider
   ```

   Its state stays in `tofu/bootstrap/terraform.tfstate` (gitignored). Keep
   it somewhere safe. If it's lost, every resource can be imported again.

2. **A Cloudflare API token**: My Profile → API Tokens → Create Token, with
   the *Zone → DNS → Edit* permission on the proxmox.computer zone only.
   The zone id is on the zone's overview page.

3. **GitHub repository secrets** (Settings → Secrets and variables → Actions):

   | secret | value |
   | --- | --- |
   | `AWS_ROLE_ARN` | bootstrap output `AWS_ROLE_ARN` |
   | `TF_STATE_BUCKET` | bootstrap output `TF_STATE_BUCKET` |
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `CLOUDFLARE_ZONE_ID` | the zone id |

   No aws keys are stored anywhere. The deploy job gets short-lived
   credentials through github's oidc, and the role trusts only jobs in the
   `production` environment of this repository, so pull requests can't
   assume it. To require an approval before each deploy, add required
   reviewers to that environment (Settings → Environments → production).

4. Push to `main`. The first run requests the certificate and waits for it
   to validate through the Cloudflare record, and CloudFront takes a while
   to create the distribution. Expect 10–20 minutes.

The apex record is a CNAME, which Cloudflare flattens. It must stay
**DNS only**: Cloudflare's proxy in front of CloudFront would put a second
cdn, with its own caching and header rules, in front of the first.

## caching

| objects | Cache-Control | why |
| --- | --- | --- |
| `_next/static/*` | `max-age=31536000, immutable` | hashed names: a new build means new names. Never deleted, so a tab still open on the previous build can load its chunks |
| everything else | `max-age=0, s-maxage=31536000, must-revalidate` | browsers revalidate every load; CloudFront keeps it until the deploy's `/*` invalidation |

## working on it locally

```sh
cd tofu
tofu fmt -recursive
tofu init -backend=false && tofu validate && tofu test
(cd bootstrap && tofu init -backend=false && tofu validate && tofu test)
```

To plan against the real account: `tofu init -backend-config=bucket=<state bucket> -backend-config=region=eu-central-1`,
export `CLOUDFLARE_API_TOKEN` and `TF_VAR_cloudflare_zone_id`, then `tofu plan`.

After a provider upgrade, re-lock for every platform that runs tofu:
`tofu providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=linux_arm64`.

**The CSP** is in `cloudfront.tf`. If the app ever needs another origin
(a font, an api), it has to be added there or the browser will block it.
Check the browser console after changing it.
