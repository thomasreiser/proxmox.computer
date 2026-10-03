# The apex points at CloudFront. Cloudflare flattens a CNAME at the root
# into A/AAAA answers. DNS only, not proxied: CloudFront is the cdn and
# terminates tls with its own certificate, and a second proxy in front of
# it would cache and rewrite headers on its own terms.

resource "cloudflare_dns_record" "site" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "CNAME"
  content = aws_cloudfront_distribution.site.domain_name
  ttl     = 300
  proxied = false
  comment = "cloudfront distribution for ${var.domain} (opentofu)"
}
