# read by the deploy workflow to upload the export and invalidate the cache

output "bucket_name" {
  description = "The bucket the static export is uploaded to."
  value       = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  description = "The CloudFront distribution to invalidate after an upload."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "Where the apex CNAME points."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "url" {
  value = "https://${var.domain}/"
}
