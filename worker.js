/**
 * ClaudeCode2OpenAIProxy
 * 
 * Author: Hex
 * GitHub: https://github.com/hexrs/ClaudeCode2OpenAIProxy
 * 
 * This Cloudflare Worker serves as a universal proxy adapter that converts Anthropic Claude Code API requests
 * (formatted for /v1/messages endpoint) into OpenAI-compatible requests (/v1/chat/completions format).
 * It forwards the converted requests to a configurable OpenAI-compatible API endpoint (e.g., OpenAI, OpenRouter, or others)
 * 
 * Configuration:
 * - API_ENDPOINT: Target OpenAI-compatible URL (default: 'https://openrouter.ai/api/v1/chat/completions').
 */

const API_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'; // Configurable OpenAI-compatible API endpoint

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function convertClaudeToOpenAIRequest(claudeRequest, modelName) {
  const openaiMessages = [];

  if (claudeRequest.system) {
    openaiMessages.push({ role: "system", content: claudeRequest.system });
  }

  for (const message of claudeRequest.messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        const toolResults = message.content.filter(c => c.type === 'tool_result');
        const otherContent = message.content.filter(c => c.type !== 'tool_result');

        if (toolResults.length > 0) {
          toolResults.forEach(block => {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          });
        }

        if (otherContent.length > 0) {
          openaiMessages.push({ 
            role: "user", 
            content: otherContent.map(block => 
              block.type === 'text' 
                ? { type: 'text', text: block.text } 
                : { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
            )
          });
        }
      } else {
        openaiMessages.push({ role: "user", content: message.content });
      }
    } else if (message.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      if (Array.isArray(message.content)) {
        message.content.forEach(block => {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          }
        });
      }
      const assistantMessage = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      openaiMessages.push(assistantMessage);
    }
  }

  const openaiRequest = {
    model: modelName,
    messages: openaiMessages,
    max_tokens: claudeRequest.max_tokens,
    temperature: claudeRequest.temperature,
    top_p: claudeRequest.top_p,
    stream: claudeRequest.stream,
    stop: claudeRequest.stop_sequences,
  };

  if (claudeRequest.tools) {
    openaiRequest.tools = claudeRequest.tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  if (claudeRequest.tool_choice) {
    if (claudeRequest.tool_choice.type === 'auto' || claudeRequest.tool_choice.type === 'any') {
      openaiRequest.tool_choice = 'auto';
    } else if (claudeRequest.tool_choice.type === 'tool') {
      openaiRequest.tool_choice = { type: 'function', function: { name: claudeRequest.tool_choice.name } };
    }
  }

  return openaiRequest;
}

function convertOpenAIToClaudeResponse(openaiResponse, model) {
  const choice = openaiResponse.choices[0];
  const contentBlocks = [];
  if (choice.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    choice.message.tool_calls.forEach(call => {
      contentBlocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      });
    });
  }
  const stopReasonMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  return {
    id: openaiResponse.id,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
    },
  };
}

function streamTransformer(model) {
  let initialized = false;
  let buffer = "";
  const messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
  const toolCalls = {};
  let contentBlockIndex = 0;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const sendEvent = (controller, event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  return (chunk, controller) => {
    if (!initialized) {
      sendEvent(controller, 'message_start', { 
        type: 'message_start', 
        message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
      });
      sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      initialized = true;
    }

    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.substring(6);
      if (data.trim() === "[DONE]") {
        sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        Object.values(toolCalls).forEach(tc => {
          if (tc.started) sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
        });
        let finalStopReason = "end_turn";
        try {
          const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
          const finishReason = lastChunk.choices[0].finish_reason;
          if (finishReason === 'tool_calls') finalStopReason = 'tool_use';
          if (finishReason === 'length') finalStopReason = 'max_tokens';
        } catch {}
        sendEvent(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
        sendEvent(controller, 'message_stop', { type: 'message_stop' });
        controller.terminate();
        return;
      }

      try {
        const openaiChunk = JSON.parse(data);
        const delta = openaiChunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
        }

        if (delta.tool_calls) {
          for (const tc_delta of delta.tool_calls) {
            const index = tc_delta.index;
            if (!toolCalls[index]) {
              toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false };
            }
            if (tc_delta.id) toolCalls[index].id = tc_delta.id;
            if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
            if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;
            if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
              contentBlockIndex++;
              toolCalls[index].claudeIndex = contentBlockIndex;
              toolCalls[index].started = true;
              sendEvent(controller, 'content_block_start', { 
                type: 'content_block_start', 
                index: contentBlockIndex, 
                content_block: { type: 'tool_use', id: toolCalls[index].id, name: toolCalls[index].name, input: {} } 
              });
            }
            if (toolCalls[index].started && tc_delta.function?.arguments) {
              sendEvent(controller, 'content_block_delta', { 
                type: 'content_block_delta', 
                index: toolCalls[index].claudeIndex, 
                delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments } 
              });
            }
          }
        }
      } catch {}
    }
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/v1/messages")) {
      return new Response(JSON.stringify({ message: "Not Found. URL must end with /v1/messages" }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders() } 
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ message: "Method Not Allowed" }), { 
        status: 405, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders() } 
      });
    }

    const apiKey = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      return new Response(JSON.stringify({ message: 'Authorization header with Bearer token is required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    try {
      const claudeRequest = await request.json();
      if (!claudeRequest.model) {
        return new Response(JSON.stringify({ message: '"model" field is required in the request body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }

      const openaiRequest = convertClaudeToOpenAIRequest(claudeRequest, claudeRequest.model);
      const openaiApiResponse = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(openaiRequest),
      });

      if (!openaiApiResponse.ok) {
        const errorBody = await openaiApiResponse.text();
        return new Response(errorBody, {
          status: openaiApiResponse.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }

      if (claudeRequest.stream) {
        const transformStream = new TransformStream({
          transform: streamTransformer(claudeRequest.model),
        });
        return new Response(openaiApiResponse.body.pipeThrough(transformStream), {
          headers: { "Content-Type": "text/event-stream", ...corsHeaders() },
        });
      }

      const openaiResponse = await openaiApiResponse.json();
      const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse, claudeRequest.model);
      return new Response(JSON.stringify(claudeResponse), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    } catch (e) {
      return new Response(JSON.stringify({ message: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};
