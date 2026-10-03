# Plans the bootstrap against a mocked aws provider: who may assume the
# deploy role is the one thing here that must never drift.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::proxmox-computer-tofu-state-123456789012"
    }
  }
}

run "only_the_deploy_environment_assumes_the_role" {
  command = plan

  assert {
    condition = anytrue([
      for c in data.aws_iam_policy_document.deploy_trust.statement[0].condition :
      c.variable == "token.actions.githubusercontent.com:sub" && c.test == "StringEquals"
      && c.values == tolist(["repo:thomasreiser/proxmox.computer:environment:production"])
    ])
    error_message = "the trust is pinned to the repo's production environment, so pull requests can't deploy"
  }

  assert {
    condition = anytrue([
      for c in data.aws_iam_policy_document.deploy_trust.statement[0].condition :
      c.variable == "token.actions.githubusercontent.com:aud" && c.values == tolist(["sts.amazonaws.com"])
    ])
    error_message = "tokens are only accepted for sts"
  }
}

run "state_bucket_is_private_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "proxmox-computer-tofu-state-123456789012"
    error_message = "the state bucket is named after the account"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "state is never public"
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "state is versioned, so a bad write can be undone"
  }
}

run "reuses_an_existing_oidc_provider" {
  command = plan

  variables {
    create_github_oidc_provider = false
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "no second github provider is created"
  }
}
