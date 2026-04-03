---
layout: fullwidth
title: Features
headline: Search, Workspace, Agent Memory, and Builder Surface
description: "Explore GNO's full feature set: hybrid search, browse tree, knowledge graph, local AI answers, multi-format indexing, agent integrations, MCP, SDK, and privacy-first local workflows."
keywords: gno features, local knowledge workspace, hybrid search, browse tree, knowledge graph, local llm, agent memory, privacy first
permalink: /features/
og_image: /assets/images/og/og-template.png
---

<section class="hero" style="padding-bottom: 2rem;">
  <h1 class="hero-title">Features</h1>
  <p class="hero-description">Everything GNO now does as a local knowledge workspace, not just a search box.</p>
</section>

<section class="features">
  <div class="features-grid">
    {% for feature in site.data.features %}
    {% if feature.link %}
    <a href="{{ feature.link | relative_url }}" class="feature-card">
    {% else %}
    <a href="{{ '/features/' | append: feature.slug | append: '/' | relative_url }}" class="feature-card">
    {% endif %}
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
    <a href="{{ '/features/web-ui/' | relative_url }}" class="btn btn-secondary btn-lg">See the Workspace</a>
  </div>
</section>
