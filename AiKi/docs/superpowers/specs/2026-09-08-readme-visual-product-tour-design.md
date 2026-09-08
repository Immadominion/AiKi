# AiKi README visual product tour

**Status:** Approved direction, ready for implementation
**Date:** 8 September 2026
**Reference:** [NetroBNB](https://github.com/AbdullahBalfaqih/NetroBNB) for the rhythm of a clear claim followed by a large visual, not for its length, copy or technical structure

## Goal

Turn the repository README into a short visual introduction to AiKi.

Someone should understand within a minute that AiKi is a marketplace where humans and AI agents can find, hire and manage work together. The README should show the quality of the product, then lead technical readers into the documentation.

## Principles

- Use simple product language.
- Show real AiKi screens instead of describing every feature.
- Keep implementation details in the linked docs.
- Use a small number of large images with a clear purpose.
- Keep the approved orange, white and black visual direction.
- Do not use a badge wall, giant architecture diagram or exhaustive endpoint list.
- Do not generate fake product interfaces. Compose graphics from current 4K captures and existing AiKi artwork.

## Structure

### 1. Hero

A full-width branded image built from the AiKi logo, orange mascot artwork and real marketplace UI. It should feel like a campaign image, not a raw screenshot.

Copy below it:

> Put agents to work.

> AiKi is a marketplace for humans and AI agents to get work done together.

Primary links: Use AiKi, watch the product film and read the docs.

### 2. Find the right help

One wide visual pairing the Manual marketplace with an agent profile. The image should communicate discovery and evaluation without asking the reader to inspect small text.

Supporting copy: browse yourself in Manual, or say what you need in Fast.

### 3. Follow the work

One wide visual moving from a request to a delivered result and review. It should make Work feel like the place where the brief, delivery and payment status stay together.

Supporting copy: know what is happening, what came back and what needs your decision.

### 4. Humans and agents work together

One wide visual combining the People surface with the existing human-agent artwork and a compact MCP or ChatGPT result. It should show that agents can bring in people and that connected models can use AiKi.

Supporting copy: people and agents can buy work, sell work or hand off a defined part of a job.

### 5. What AiKi gives you

At most five short bullets:

- Fast and Manual ways to find help
- Agent and human provider profiles
- Clear jobs, delivery and review
- Separate payment and action permissions
- MCP and API access for connected agents

### 6. Try it and build on it

Link to the live product and current product documentation. Keep local setup to the minimum commands needed to run the API and web app. Point all architecture, contracts, MCP and research questions to the documentation index.

## Visual production

Create README-specific files under `docs/media/readme/`. Keep the original captures and artwork untouched.

- Use the current 4320 by 2430 product captures as source material.
- Crop screens to the decision or action each chapter is proving.
- Place crops inside crisp white or black frames with restrained orange accents.
- Use mascots as supporting characters, not as decoration over important UI.
- Keep text inside the images minimal. The README carries the explanation.
- Export WebP files at a practical GitHub width with enough resolution for Retina screens.
- Add useful alt text for each image.

Image generation is optional. If used, it may supply only a decorative background or supporting illustration. It must not invent interface states, transactions, users or product results.

## Length and quality bar

The final README should remain around 120 lines or fewer, excluding unavoidable code-block lines. Each image must answer a different question. Remove any section whose information is already clear from another section or belongs in the docs.

The finished result must render correctly on GitHub, use repository-relative asset paths, contain no broken local links, and preserve truthful distinctions between internal points, payment for work and delegated spending authority.

## Verification

- Preview the rendered Markdown or inspect it through GitHub-compatible rendering.
- Confirm all local image and documentation links resolve.
- Check exported images at full width and at a narrow README width.
- Confirm no source capture or approved landing asset was overwritten.
- Run `git diff --check`.

