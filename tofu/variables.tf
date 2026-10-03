variable "domain" {
  description = "The site's apex domain, served by CloudFront and pointed at it from Cloudflare."
  type        = string
  default     = "proxmox.computer"
}

variable "cloudflare_zone_id" {
  description = "The Cloudflare zone that holds var.domain."
  type        = string
}

variable "aws_region" {
  description = "Region of the site bucket. CloudFront and its certificate are global / us-east-1 regardless."
  type        = string
  default     = "eu-central-1"
}

variable "price_class" {
  description = "CloudFront edge locations to serve from. PriceClass_100 is north america and europe."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

locals {
  tags = {
    project    = var.domain
    managed-by = "opentofu"
  }

  # "proxmox.computer" → "proxmox-computer"; the account id keeps the
  # bucket name, which is global across aws, from colliding with anyone's
  name        = replace(var.domain, ".", "-")
  bucket_name = "${local.name}-site-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}
