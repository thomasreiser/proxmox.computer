# Plans the stack against mocked providers: no aws or cloudflare account
# is touched, and what's asserted is what the config itself promises.
# Run with `tofu test` from tofu/.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  # the provider still validates arns it's handed, so mocked ones are real-shaped
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/proxmox-computer-viewer-request"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E000000000000"
      domain_name = "d0000000000000.cloudfront.net"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::proxmox-computer-site-123456789012"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  # what acm hands back for a dns-validated certificate, trailing dots and all
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [{
        domain_name           = "proxmox.computer"
        resource_record_name  = "_abc.proxmox.computer."
        resource_record_type  = "CNAME"
        resource_record_value = "_def.acm-validations.aws."
      }]
    }
  }
}

mock_provider "cloudflare" {}

variables {
  cloudflare_zone_id = "0123456789abcdef0123456789abcdef"
}

run "bucket_is_private" {
  command = plan

  assert {
    condition     = aws_s3_bucket.site.bucket == "proxmox-computer-site-123456789012"
    error_message = "the bucket is named after the domain and the account"
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.site.block_public_acls,
      aws_s3_bucket_public_access_block.site.block_public_policy,
      aws_s3_bucket_public_access_block.site.ignore_public_acls,
      aws_s3_bucket_public_access_block.site.restrict_public_buckets,
    ])
    error_message = "every public-access block is on"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.site.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "acls are disabled"
  }
}

run "served_over_https_only" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.site.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "http is redirected to https: the vault needs a secure origin"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "tls 1.2 or newer"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == toset(["proxmox.computer"])
    error_message = "the distribution answers for the apex"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.site.signing_behavior == "always"
    error_message = "cloudfront signs every request to the private bucket"
  }

  assert {
    condition     = aws_acm_certificate.site.domain_name == "proxmox.computer"
    error_message = "the certificate covers the apex"
  }
}

run "routes_resolve" {
  command = plan

  assert {
    condition     = aws_cloudfront_function.viewer_request.code == file("${path.module}/functions/viewer-request.js")
    error_message = "the viewer-request function is the tested one in functions/"
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.default_cache_behavior[0].function_association).event_type == "viewer-request"
    error_message = "the rewrite runs on every viewer request"
  }

  assert {
    condition = alltrue([
      for e in aws_cloudfront_distribution.site.custom_error_response :
      e.response_code == 404 && e.response_page_path == "/404.html"
    ])
    error_message = "a missing page (403 from the private bucket, or 404) shows the export's 404"
  }

  assert {
    condition     = toset([for e in aws_cloudfront_distribution.site.custom_error_response : e.error_code]) == toset([403, 404])
    error_message = "both 403 and 404 are mapped"
  }
}

run "security_headers" {
  command = plan

  assert {
    condition     = strcontains(local.content_security_policy, "connect-src 'self'")
    error_message = "the page can't send anything to another origin"
  }

  assert {
    condition     = strcontains(local.content_security_policy, "frame-ancestors 'none'")
    error_message = "the wizard can't be framed"
  }

  assert {
    condition     = !strcontains(local.content_security_policy, "unsafe-eval")
    error_message = "no eval"
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.site.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec >= 31536000
    error_message = "hsts for at least a year"
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.site.security_headers_config[0].frame_options[0].frame_option == "DENY"
    error_message = "x-frame-options deny"
  }
}

run "dns_points_at_cloudfront_unproxied" {
  command = plan

  assert {
    condition     = cloudflare_dns_record.site.name == "proxmox.computer" && cloudflare_dns_record.site.type == "CNAME"
    error_message = "the apex is a CNAME"
  }

  assert {
    condition     = cloudflare_dns_record.site.proxied == false
    error_message = "dns only: cloudflare doesn't proxy in front of cloudfront"
  }

  assert {
    condition     = alltrue([for r in cloudflare_dns_record.validation : r.proxied == false])
    error_message = "acm validation records can't be proxied"
  }

  assert {
    condition     = cloudflare_dns_record.validation["proxmox.computer"].name == "_abc.proxmox.computer"
    error_message = "the validation record's name loses acm's trailing dot"
  }

  assert {
    condition     = cloudflare_dns_record.validation["proxmox.computer"].content == "_def.acm-validations.aws"
    error_message = "the validation record's target loses acm's trailing dot"
  }
}

run "rejects_an_unknown_price_class" {
  command = plan

  variables {
    price_class = "PriceClass_Cheap"
  }

  expect_failures = [var.price_class]
}
