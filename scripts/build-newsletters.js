#!/usr/bin/env node
const path = require('path');
const { publishNewsletterSite } = require('../lib/newsletter-pages');

const root = path.join(__dirname, '..');
const issues = publishNewsletterSite({
  newsletterDir: path.join(root, 'newsletter'),
  outDir: path.join(root, 'newsletters'),
});

if (!issues.length) {
  console.log('No sent newsletters to publish.');
} else {
  console.log(`Published ${issues.map((issue) => issue.slug).join(', ')}`);
}
