"""Invoked by the live smoke runner; caller key arrives only over stdin."""
import json
import secrets
import sys


def main():
    config = json.load(sys.stdin)
    sys.path.insert(0, config["hermesDirectory"])
    from agent.gemini_native_adapter import GeminiNativeClient

    marker = "fixture_" + secrets.token_hex(4)
    value = secrets.randbelow(90000) + 10000
    messages = [
        {"role": "system", "content": "Use the lookup tool. After its result reply exactly MARKER:VALUE, using the marker in the history and the numeric tool result."},
        {"role": "user", "content": "Remember marker " + marker},
        {"role": "assistant", "content": "I will remember it."},
        {"role": "user", "content": "Look up key sample using hermes_probe_lookup."},
    ]
    tools = [{"type": "function", "function": {
        "name": "hermes_probe_lookup", "description": "Read a synthetic fixture.",
        "parameters": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
    }}]
    with GeminiNativeClient(api_key=config["key"], base_url=config["baseUrl"]) as client:
        result = client.chat.completions.create(
            model="gemini-3.8-flash-medium", messages=messages, tools=tools,
            tool_choice={"type": "function", "function": {"name": "hermes_probe_lookup"}},
            max_tokens=8192,
        )
        message = result.choices[0].message
        assert len(message.tool_calls) == 1
        call = message.tool_calls[0]
        assert call.function.name == "hermes_probe_lookup"
        assert json.loads(call.function.arguments) == {"key": "sample"}
        assert call.extra_content["google"]["thought_signature"]
        calls = json.loads(json.dumps(message.tool_calls, default=vars))
        messages.append({"role": "assistant", "content": message.content, "tool_calls": calls})
        messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"value": value})})
        chunks = client.chat.completions.create(
            model="gemini-3.8-flash-medium", messages=messages, tools=tools,
            max_tokens=8192, stream=True,
        )
        answer = "".join(chunk.choices[0].delta.content or "" for chunk in chunks if chunk.choices).strip()
        assert answer == f"{marker}:{value}"
    print("PASS installed Hermes GeminiNativeClient: tool replay and streamed answer")


try:
    main()
except Exception as error:
    print("FAIL Hermes smoke:", type(error).__name__)
    sys.exit(1)
