export function parseFindings(reviewText: string): string[] {
	const severity = "Critical|High|Medium|Low|Nit";
	// A terminal summary is not part of the last publishable finding.
	const body = reviewText.split(/^#{1,3}\s+(?:summary|conclusion|overall assessment|residual risks)\b.*$/im)[0] ?? "";
	const headingPattern = new RegExp(`^###\\s+\\[(${severity})\\][^\\n]*(?:\\n(?!###\\s+\\[(?:${severity})\\]).*)*`, "gim");
	const headings = body.match(headingPattern)?.map(finding => finding.trim()).filter(Boolean) ?? [];
	if (headings.length) return headings;
	const bulletPattern = new RegExp(`^(?:[-*]|\\d+\\.)\\s+(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-].*(?:\\n(?![-*]\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])|\\d+\\.\\s+(?:(?:\\*\\*)?(?:${severity})(?:\\*\\*)?[:\\s-])).*)*`, "gim");
	return body.match(bulletPattern)?.map(finding => finding.trim()).filter(Boolean) ?? [];
}

export function isTestPath(path: string): boolean {
	return /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py)|(?:^|\/)(?:test|tests|__tests__)\/|(?:^|\/)tests?\.rs$)/i.test(path);
}
