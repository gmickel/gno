---
layout: page
title: Frequently Asked Questions
headline: Answers for Search, Workspace, and Agent Use
description: Common questions about GNO's local knowledge workspace. Covers installation, hybrid search, web UI, browse tree, AI answers, MCP, skills, privacy, and troubleshooting.
keywords: gno faq, local knowledge workspace, hybrid search faq, gno web ui, gno mcp, gno skills, local rag help
permalink: /faq/
---

Find answers to common questions about GNO's search engine, workspace UI, and agent integrations.

{% for category in site.data.faq %}

## {{ category.category }}

{% for item in category.questions %}

<details class="faq-item">
<summary class="faq-question">{{ item.q }}</summary>
<div class="faq-answer" markdown="1">
{{ item.a }}
</div>
</details>
{% endfor %}

{% endfor %}

---

## Still Have Questions?

- [Quick Start Guide](/docs/QUICKSTART/) - Get up and running
- [CLI Reference](/docs/CLI/) - All commands explained
- [Troubleshooting](/docs/TROUBLESHOOTING/) - Common issues and fixes
- [GitHub Issues](https://github.com/gmickel/gno/issues) - Report bugs or request features

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {% for category in site.data.faq %}{% for item in category.questions %}{
      "@type": "Question",
      "name": {{ item.q | jsonify }},
      "acceptedAnswer": {
        "@type": "Answer",
        "text": {{ item.a | strip_html | jsonify }}
      }
    }{% unless forloop.last %},{% endunless %}{% endfor %}{% unless forloop.last %},{% endunless %}{% endfor %}
  ]
}
</script>
