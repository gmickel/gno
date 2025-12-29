---
layout: fullwidth
title: Features
description: GNO features overview. Hybrid search, local LLM answers, multi-format indexing, privacy-first design, MCP integration, and collections.
keywords: gno features, local search features, hybrid search, local llm, privacy search
permalink: /features/
---

<section class="hero" style="padding-bottom: 2rem;">
  <h1 class="hero-title">Features</h1>
  <p class="hero-description">Everything you need for powerful local document search</p>
</section>

<section class="features">
  <div class="features-grid">
    {% for feature in site.data.features %}
    <a href="{{ '/features/' | append: feature.slug | append: '/' | relative_url }}" class="feature-card">
      <div class="feature-card-icon">{% include icons.html icon=feature.icon size="24" %}</div>
      <h3 class="feature-card-title">{{ feature.title }}</h3>
      <p class="feature-card-description">{{ feature.description | truncate: 120 }}</p>
    </a>
    {% endfor %}
  </div>
</section>

<section style="text-align: center; padding: 4rem 0;">
  <h2>Ready to Get Started?</h2>
  <div class="hero-actions" style="margin-top: 1.5rem;">
    <a href="{{ '/docs/QUICKSTART/' | relative_url }}" class="btn btn-primary btn-lg">Quick Start</a>
    <a href="{{ '/faq/' | relative_url }}" class="btn btn-secondary btn-lg">FAQ</a>
  </div>
</section>
