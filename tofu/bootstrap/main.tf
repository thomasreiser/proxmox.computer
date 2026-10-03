# Run once, by hand, with admin credentials (see ../README.md). Makes what
# the deploy pipeline needs before it can run itself:
#
#   - the bucket that holds the site stack's state
#   - github's oidc identity provider in this aws account
#   - the role the deploy job assumes through it: no long-lived aws keys
#     in github, only the role's arn
#
# Its own state stays local (terraform.tfstate here, gitignored). It's
# small and every resource in it can be re-imported if it's ever lost.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project    = "proxmox.computer"
      managed-by = "opentofu"
    }
  }
}

variable "aws_region" {
  description = "Region of the state bucket; the site stack's buckets live here too."
  type        = string
  default     = "eu-central-1"
}

variable "github_repository" {
  description = "owner/name of the repository whose deploy job may assume the role."
  type        = string
  default     = "thomasreiser/proxmox.computer"
}

variable "github_environment" {
  description = "The github environment the deploy job runs in; only that job gets the role."
  type        = string
  default     = "production"
}

variable "create_github_oidc_provider" {
  description = "An account holds github's oidc provider at most once: set false if another project already made it."
  type        = bool
  default     = true
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  github_oidc  = "token.actions.githubusercontent.com"
  state_bucket = "proxmox-computer-tofu-state-${local.account_id}"
  # matches local.bucket_name in the site stack
  site_buckets = "arn:aws:s3:::proxmox-computer-site-*"
}

# ── state bucket ─────────────────────────────────────────────────────────

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── github oidc ──────────────────────────────────────────────────────────

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1

  url = "https://${local.github_oidc}"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # only a job in the deploy environment: pull requests and other
    # branches never get the role, whatever their workflow says
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "proxmox-computer-deploy"
  description          = "assumed by ${var.github_repository}'s deploy job"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    sid       = "StateReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/proxmox.computer/*"]
  }

  # the site stack creates and manages its bucket; the upload step writes it
  statement {
    sid       = "SiteBucket"
    actions   = ["s3:*"]
    resources = [local.site_buckets, "${local.site_buckets}/*"]
  }

  # most cloudfront and acm actions don't support resource-level scoping
  statement {
    sid       = "CloudFront"
    actions   = ["cloudfront:*"]
    resources = ["*"]
  }

  statement {
    sid       = "Certificates"
    actions   = ["acm:*"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["us-east-1"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# ── for the github secrets ───────────────────────────────────────────────

output "AWS_ROLE_ARN" {
  value = aws_iam_role.deploy.arn
}

output "TF_STATE_BUCKET" {
  value = aws_s3_bucket.state.bucket
}
