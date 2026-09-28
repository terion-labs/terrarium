<script setup>
import { withBase } from "vitepress";
</script>

# For AI Agents

This page is written for AI agents that install, operate, or build on a Terrarium host. The same content is published as a single Markdown file, which is easier for agents to fetch and parse:

<p><a :href="withBase('/agents.md')" target="_self"><code>agents.md</code></a>. Point your agent at this URL, or add it to the agent's context.</p>

<!--@include: ./public/agents.md{3,}-->
