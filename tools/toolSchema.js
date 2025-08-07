const toolsSchema = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate to a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Fill in a field by CSS selector',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click a button or link by CSS selector',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          waitFor: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            default: 'domcontentloaded',
          },
          delayMs: {
            type: 'number',
            default: 2000,
            description: 'Milliseconds to wait after click',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dom',
      description: 'Return trimmed HTML from the current page',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            default: 100000,
            description: 'Max characters to return',
          },
          exclude: {
            type: 'boolean',
            default: true,
            description: 'Whether to exclude noisy tags like script/style/etc.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_text',
      description: 'Search page HTML for specific text',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_menu',
      description: 'Click an element (like a hamburger menu or profile icon) to reveal a dropdown or hidden menu',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          delayMs: {
            type: 'number',
            default: 1000,
            description: 'Optional delay after expanding menu (in ms)',
          }
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_text',
      description: 'Clicks an element by visible text content, useful for buttons or links when selector is unknown',
      parameters: {
        type: 'object',
        properties: {
          text: { 
            type: 'string',
            description: 'Visible text to search for and click on the page' 
          }
        },
        required: ['text']
      }
    }
  },
  // {
  //   type: 'function',
  //   function: {
  //     name: 'get_dom_focus_hint',
  //     description: 'Returns recommended DOM sections (e.g., "header", "main", "footer") to prioritize for the current task.',
  //     parameters: {
  //       type: 'object',
  //       properties: {
  //         prompt: {
  //           type: 'string',
  //           description: 'The current user instruction or task description'
  //         }
  //       },
  //       required: ['prompt']
  //     }
  //   }
  // },
  {
    type: 'function',
    function: {
      name: 'get_dom_chunk',
      description: 'Return a specific chunk of the DOM by index',
      parameters: {
        type: 'object',
        properties: {
          chunkIndex: { type: 'number' },
          totalChunks: { type: 'number' }
        },
        required: ['chunkIndex', 'totalChunks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Takes a screenshot of the current page',
      parameters: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description: 'Optional label for the screenshot filename',
          },
        },
        required: [],
      },
    },
  }
  
    
];

export default toolsSchema;