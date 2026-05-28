import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import dotenv from "dotenv";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();


// Connect to Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// Initialize the new, modern McpServer
const server = new McpServer({
  name: "Accountability-MCP",
  version: "1.0.0",
});

// ==========================================
// TOOL 1: Add Task
// ==========================================
server.tool(
  "add_task",
  "Add a new task to the accountability tracker.",
  {
    title: z.string().describe("Name of the task"),
    deadline: z.string().describe("ISO 8601 string of the deadline (e.g. 2026-05-30T15:00:00)"),
    priority: z.enum(["imp", "very_imp", "very_very_imp"]).describe("imp = ₹50, very_imp = ₹100, very_very_imp = ₹200"),
  },
  async ({ title, deadline, priority }) => {
    // Safety Check: Prevent Past Deadlines
    if (new Date(deadline) <= new Date()) {
      return { content: [{ type: "text", text: "Error: Deadline cannot be in the past." }], isError: true };
    }

    const { data, error } = await supabase
      .from("tasks")
      .insert([{ title, deadline, priority }])
      .select();

    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    return { content: [{ type: "text", text: `Task added successfully! ID: ${data[0].id}` }] };
  }
);

// ==========================================
// TOOL 2: Get Tasks
// ==========================================
server.tool(
  "get_tasks",
  "Fetch tasks from the database.",
  {
    status: z.enum(["pending", "completed", "failed", "all"]).describe("Filter by status."),
  },
  async ({ status }) => {
    let query = supabase.from("tasks").select("*").order("deadline", { ascending: true });
    
    if (status !== "all") query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ==========================================
// TOOL 3: Complete Task
// ==========================================
server.tool(
  "complete_task",
  "Mark a task as complete. Calculates the penalty if late.",
  {
    task_id: z.string().describe("UUID of the task"),
  },
  async ({ task_id }) => {
    const now = new Date();

    const { data: task, error: fetchError } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();

    if (fetchError || !task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
    if (task.status !== "pending") return { content: [{ type: "text", text: `Task is already ${task.status}.` }], isError: true };

    const deadlineDate = new Date(task.deadline);
    const diffMs = now.getTime() - deadlineDate.getTime();
    const minutesLate = Math.floor(diffMs / 60000);

    let netPoints = 0;
    if (minutesLate <= 0) {
      netPoints = task.reward_amount;
    } else {
      const rawPenalty = minutesLate * task.penalty_rate;
      netPoints = -Math.min(rawPenalty, task.max_penalty);
    }

    const { error: updateError } = await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: now.toISOString(), net_points: netPoints })
      .eq("id", task_id);

    if (updateError) return { content: [{ type: "text", text: updateError.message }], isError: true };

    const statusText = netPoints > 0 ? `On time! Earned ₹${netPoints}.` : `Late by ${minutesLate} mins. Penalty: ₹${Math.abs(netPoints)}.`;
    return { content: [{ type: "text", text: `Task marked complete. ${statusText}` }] };
  }
);

// ==========================================
// TOOL 4: Delete Task
// ==========================================
server.tool(
  "delete_task",
  "Permanently delete a task.",
  {
    task_id: z.string().describe("UUID of the task"),
  },
  async ({ task_id }) => {
    const { error } = await supabase.from("tasks").delete().eq("id", task_id);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return { content: [{ type: "text", text: "Task deleted successfully." }] };
  }
);

// ==========================================
// TOOL 5: Get Current Time (IST)
// ==========================================
server.tool(
  "get_current_time",
  "Get the exact current date and time in IST (Indian Standard Time). Call this before adding tasks if the user uses relative time (like 'tomorrow' or 'in 2 hours') to ensure accuracy.",
  async () => {
    const now = new Date();
    
    // Format it beautifully in Indian Standard Time
    const istTime = now.toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "long",
    });
    
    return { 
      content: [{ 
        type: "text", 
        text: `The current real-world time is: ${istTime}` 
      }] 
    };
  }
);

// ==========================================
// START SERVER (Cloud/SSE Version)
// ==========================================
const app = express();

let transport: SSEServerTransport | null = null;

// 1. The connection endpoint (GET)
app.get("/sse", async (req, res) => {
  try {
    console.log("New connection request received.");
    
    if (transport) {
      try {
        await transport.close();
      } catch (e) {
        console.error("Error closing previous transport", e);
      }
    }
    

    transport = new SSEServerTransport("/sse", res);
    await server.connect(transport);
    console.log("Claude Desktop connected successfully via SSE!");
    
  } catch (error) {
    console.error("Fatal SSE Connection Error:", error);
    res.status(500).send("Internal Server Error");
  }
});



app.post("/sse", async (req, res) => {
  if (!transport) {
    res.status(503).send("SSE connection not established");
    return;
  }
  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to handle post message:", error);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cloud Accountability MCP Server running on port ${PORT}`);
});


// // ==========================================
// // START SERVER
// // ==========================================
// async function main() {
//   const transport = new StdioServerTransport();
//   await server.connect(transport);
//   console.error("Accountability MCP Server running via stdio");
// }

// main().catch(console.error);