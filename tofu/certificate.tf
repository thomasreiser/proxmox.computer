# The certificate CloudFront serves var.domain with, validated through a
# DNS record in Cloudflare.

resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1

  domain_name       = var.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # keyed by a name known at plan time, so for_each never depends on an
  # attribute that only exists after the certificate is requested
  validation = { for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => o }
}

resource "cloudflare_dns_record" "validation" {
  for_each = toset([var.domain])

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(local.validation[each.key].resource_record_name, ".")
  type    = local.validation[each.key].resource_record_type
  content = trimsuffix(local.validation[each.key].resource_record_value, ".")
  ttl     = 60
  proxied = false
  comment = "acm validation for ${var.domain} (opentofu)"
}

resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in cloudflare_dns_record.validation : r.name]
}
