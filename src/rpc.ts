import { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared RPC contract between the TUI part (Mac) and the server part.
 *
 * Upload moves bytes from the TUI host to the OpenCode server.
 * Download moves bytes from the OpenCode server back to the TUI host.
 *
 * Both directions use base64 so the payload stays JSON-serializable and fits
 * the existing OpenCode client/RPC transport.
 */
export const Files: Rpc.PortableDefinition = Rpc.define({
  id: "acme.files",
  methods: {
    info: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          version: { type: "string" },
          maxBytes: { type: "number" },
          ttlHours: { type: "number" },
          modes: {
            type: "array",
            items: { type: "string" },
          },
          uploadRoot: { type: "string" },
        },
        required: ["version", "maxBytes", "ttlHours", "modes", "uploadRoot"],
        additionalProperties: false,
      },
    },

    upload: {
      input: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          data: { type: "string", minLength: 1 },
        },
        required: ["name", "data"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          size: { type: "number" },
        },
        required: ["path", "name", "size"],
        additionalProperties: false,
      },
    },

    download: {
      input: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          name: { type: "string" },
          data: { type: "string" },
          size: { type: "number" },
        },
        required: ["name", "data", "size"],
        additionalProperties: false,
      },
    },

    prepareUpload: {
      input: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          size: { type: "number", minimum: 1 },
        },
        required: ["name", "size"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          name: { type: "string" },
          size: { type: "number" },
        },
        required: ["id", "path", "name", "size"],
        additionalProperties: false,
      },
    },

    finishUpload: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          size: { type: "number" },
        },
        required: ["path", "name", "size"],
        additionalProperties: false,
      },
    },

    abortUpload: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },

    prepareDownload: {
      input: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          name: { type: "string" },
          size: { type: "number" },
          root: { type: "string" },
          relativePath: { type: "string" },
        },
        required: ["name", "size", "root", "relativePath"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
