# Providers and models

Ollama works in Plan and Agent mode. Agent mode uses Goose ACP and requires a model that supports its developer-tool calls. The other providers below run tool-free Plan chats.

| Provider | Configuration |
| --- | --- |
| LM Studio | Start its local OpenAI-compatible server. The default address is `http://127.0.0.1:1234/v1`. |
| Compatible local API | Enter an IPv4 loopback address ending in `/v1`. The server must support `GET /models` and streaming `POST /chat/completions`. |
| OpenAI | Enter an API key from the [OpenAI API platform](https://platform.openai.com/api-keys). |
| Anthropic | Enter an API key from the [Claude Console](https://platform.claude.com/). |
| Google Gemini | Enter a Gemini API key from [Google AI Studio](https://aistudio.google.com/api-keys). |
| OpenRouter | Enter an API key from [OpenRouter](https://openrouter.ai/settings/keys). |

Open **Settings → Providers & models**, choose a provider and enable it. Enter a key if required, save, and select **Test connection**. A successful check verifies model listing. Model access, supported message types and generation still depend on the selected model and account. You can enter a model ID manually when discovery is incomplete.

Plan and Agent defaults are independent. You can choose another model for an existing chat. When you send a Plan turn to a cloud API, the provider receives text from the conversation. Review pasted or attached project content before confirming. The provider may bill that request. Diagnostic usage fields show measured token counts when the provider reports them.

WiskHarness has no subscription sign-in. Use the authorized sign-in provided by [OpenAI Codex](https://developers.openai.com/codex/auth) or [Claude Code](https://code.claude.com/docs/en/authentication) for those tools. API access and billing depend on your provider account and plan.
