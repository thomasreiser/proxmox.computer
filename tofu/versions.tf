terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # bucket and region come from `tofu init -backend-config=...` (the state
  # bucket is made once by ./bootstrap). use_lockfile locks the state with
  # a .tflock object next to it, so no dynamodb table is needed.
  backend "s3" {
    key          = "proxmox.computer/site.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront only takes certificates from ACM in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

# reads CLOUDFLARE_API_TOKEN from the environment
provider "cloudflare" {}
