import "dotenv/config";
import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { intro, isCancel, select, text } from "@clack/prompts";
import chalk from "chalk";

type Tool = {
  name: string;
  description: string;
  inputSchema: {
    properties: Record<string, any>;
  };
};

type Resource = {
  uri: string;
  name: string;
};

type Content = {
  text: string;
};

type ToolRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ToolRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

interface FunctionParameters {
  type: "object";
  properties?: Record<string, any>;
  required?: string[];
}

interface ToolFunction {
  name: string;
  description: string;
  parameters?: FunctionParameters;
}

interface ToolSpec {
  type: "function";
  function: ToolFunction;
}

async function callAI(messages: ChatMessage[], tools?: ToolSpec[]) {
  if (!process.env.OPEN_AI_API_KEY) {
    throw new Error("OPEN_AI_API_KEY environment variable is not set");
  }

  // Debug: Log the tools to see their structure
  // if (tools) {
  //   console.log("Tools being sent:", JSON.stringify(tools, null, 2));
  // }

  const requestBody: any = {
    model: "gpt-3.5-turbo",
    messages,
    max_tokens: 4096,
  };

  // Only add tools if they exist and have proper structure
  if (tools && tools.length > 0) {
    // Validate tools structure
    const validatedTools = tools.map((tool, index) => {
      if (!tool.type) {
        throw new Error(
          `Tool at index ${index} is missing required 'type' field`
        );
      }
      if (tool.type !== "function") {
        throw new Error(
          `Tool at index ${index} has invalid type: ${tool.type}`
        );
      }
      if (!tool.function) {
        throw new Error(
          `Tool at index ${index} is missing required 'function' field`
        );
      }
      return tool;
    });

    requestBody.tools = validatedTools;
    requestBody.tool_choice = "auto";
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPEN_AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  // console.log("Raw OpenAI response:", JSON.stringify(data, null, 2)); // Debug log
  const choice = data.choices[0];
  // Handle tool calls if present
  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
    return choice.message.tool_calls;
  }
  // Otherwise, return the message content
  return choice.message.content;
}

(async function main() {
  const serverProcess = spawn("node", ["../server/dist/index.js"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = readline.createInterface({
    input: serverProcess.stdout,
    output: undefined,
  });

  let lastId = 0;
  async function send(
    method: string,
    params: object = {},
    isNotification?: boolean
  ) {
    serverProcess.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: isNotification ? undefined : lastId++,
      }) + "\n"
    );
    if (isNotification) {
      return;
    }
    const json = await rl.question("");
    return JSON.parse(json).result;
  }

  const {
    serverInfo,
    capabilities,
  }: {
    serverInfo: { name: string; version: string };
    capabilities: {
      tools?: any;
      resources?: any;
    };
  } = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "diy-client", version: "0.1.0" },
  });
  await send("notifications/initialized", {}, true);
  const tools: Tool[] = capabilities.tools
    ? (await send("tools/list", { _meta: { progressToken: 1 } })).tools
    : [];
  const resources: Resource[] = capabilities.resources
    ? (await send("resources/list", { _meta: { progressToken: 1 } })).resources
    : [];

  intro(`Connected to ${serverInfo.name} v${serverInfo.version}`);

  async function callAIWithTools(messages: ChatMessage[]) {
    const result = await callAI(
      messages,
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            ...tool.inputSchema,
          },
        },
      }))
    );

    return result;
  }

  function dumpContent(content: { text: string }[]) {
    for (const line of content) {
      try {
        console.log(JSON.parse(line.text));
      } catch (e) {
        console.log(line.text);
      }
    }
  }

  // Add a system prompt to guide the model
  const systemPrompt: ChatMessage = {
    role: "system",
    content:
      "You are a helpful coffee shop assistant. When asked for recommendations, use the available drink information and make a judgment. Do not repeatedly request the same information. After you have all drink details, always answer the user's question directly. If you already have all drink info, do not call tools again.",
  };

  while (true) {
    const options = [{ value: "ai", label: "Ask the AI" }];
    if (resources.length > 0) {
      options.unshift({ value: "resource", label: "Get a resource" });
    }
    if (tools.length > 0) {
      options.unshift({ value: "tool", label: "Run a tool" });
    }
    const action = await select({
      message: "What would you like to do?",
      options,
    });
    if (isCancel(action)) {
      process.exit(0);
    }

    if (action === "tool") {
      const tool = await select({
        message: "Select a tool.",
        options: tools.map((tool) => ({ value: tool, label: tool.name })),
      });

      if (isCancel(tool)) {
        process.exit(0);
      }

      const args: Record<string, any> = {};
      for (const key of Object.keys(tool?.inputSchema.properties ?? {}).filter(
        (key) => tool?.inputSchema?.properties?.[key]?.type === "string"
      )) {
        const answer = await text({
          message: `${key}:`,
          initialValue: "",
        });
        if (isCancel(answer)) {
          process.exit(0);
        }
        args[key] = answer;
      }

      const {
        content,
      }: {
        content: Content[];
      } = await send("tools/call", {
        name: tool.name,
        arguments: args,
      });
      dumpContent(content);
    }

    if (action === "resource") {
      const resource = await select({
        message: "Select a resource.",
        options: resources.map((resource) => ({
          value: resource,
          label: resource.name,
        })),
      });

      if (isCancel(resource)) {
        process.exit(0);
      }

      const { contents }: { contents: Content[] } = await send(
        "resources/read",
        {
          uri: resource.uri,
        }
      );

      dumpContent(contents);
    }

    if (action === "ai") {
      const prompt = await text({
        message: "What would you like to ask?",
        defaultValue: "What kinds of drinks do you have?",
      });
      if (isCancel(prompt)) {
        process.exit(0);
      }

      // Start with the system prompt and user message
      const messages: ChatMessage[] = [
        systemPrompt,
        { role: "user", content: prompt },
      ];
      let toolCallHistory: string[] = [];
      let toolCallRepeatCount = 0;
      let lastToolCallSignature = "";
      let finalAnswerGiven = false;

      let promptResult = await callAIWithTools(messages);
      while (!finalAnswerGiven) {
        if (typeof promptResult === "string") {
          console.log(promptResult);
          finalAnswerGiven = true;
          break;
        }
        // If the model returns tool calls, add the assistant message with tool_calls
        const results = Array.isArray(promptResult)
          ? promptResult
          : [promptResult];
        // Build the assistant message with tool_calls
        const assistantToolCallMsg: any = {
          role: "assistant",
          content: null,
          tool_calls: results.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })),
        };
        messages.push(assistantToolCallMsg);

        // Detect repeated tool calls
        const toolCallSignature = results
          .map(
            (tc) =>
              `${tc.function?.name || tc.name}:${
                tc.function?.arguments || tc.input
              }`
          )
          .join("|");
        if (toolCallSignature === lastToolCallSignature) {
          toolCallRepeatCount++;
        } else {
          toolCallRepeatCount = 0;
          lastToolCallSignature = toolCallSignature;
        }
        if (toolCallRepeatCount >= 2) {
          // Summarize all tool results and force the model to answer
          const summary = toolCallHistory.join("\n");
          messages.push({
            role: "user",
            content: `You have already received all drink information. Here is a summary:\n${summary}\nPlease answer the user's question directly.`,
          });
          promptResult = await callAIWithTools(messages);
          if (typeof promptResult === "string") {
            console.log(promptResult);
            finalAnswerGiven = true;
          }
          break;
        }

        // For each tool call, execute the tool and add a tool result message
        for (const toolCall of results) {
          if (toolCall.type === "function" || toolCall.type === "tool_use") {
            console.log(
              chalk.blueBright(
                `Requesting tool call ${
                  toolCall.function?.name || toolCall.name
                } - ${JSON.stringify(
                  toolCall.function?.arguments || toolCall.input
                )}`
              )
            );
            const { content }: { content: Content[] } = await send(
              "tools/call",
              {
                name: toolCall.function?.name || toolCall.name,
                arguments: toolCall.function?.arguments || toolCall.input,
              }
            );
            // Format tool result as a human-readable string
            let toolResultString = content[0].text;
            try {
              const parsed = JSON.parse(content[0].text);
              if (parsed && parsed.name && parsed.price && parsed.description) {
                toolResultString = `${parsed.name}: $${parsed.price} - ${parsed.description}`;
              }
            } catch (e) {
              // Not JSON, use as is
            }
            console.log("Tool result being sent:", toolResultString);
            toolCallHistory.push(toolResultString);
            const toolResultMessage: ChatMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResultString,
            };
            messages.push(toolResultMessage);
          } else if (toolCall.type === "text") {
            // console.log(toolCall.text);
          }
        }
        // After all tool results, get the final answer from the model
        promptResult = await callAIWithTools(messages);
        // Debug log for follow-up response
        console.log(
          "Raw OpenAI follow-up response:",
          JSON.stringify(promptResult, null, 2)
        );
      }
    }
  }
})();
