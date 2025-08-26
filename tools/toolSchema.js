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
      description: 'Click a button or link by CSS selector. If this click opens an OAuth window/new tab, prefer using click_and_follow_popup instead.',
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
  },
  {
  type: 'function',
  function: {
    name: 'click_and_follow_popup',
    description:
      'Click a selector that opens a new tab/window (e.g., OAuth) and switch control to it. Falls back to same-tab navigation if no popup appears.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS or text selector to click' },
        expectedUrlHost: {
          type: 'string',
          description: "Optional hostname hint like 'accounts.google.com'"
        },
        timeoutMs: {
          type: 'number',
          default: 20000,
          description: 'How long to wait for the popup or navigation'
        }
      },
      required: ['selector']
    }
  }
},
{
  type: 'function',
  function: {
    name: 'switch_to_page',
    description:
      "Switch agent focus between known tabs/pages (e.g., back to 'main' or to the latest popup). Use a pageId previously returned by click_and_follow_popup to target a specific tab.",
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "One of: 'main', 'latest', or a pageId returned by click_and_follow_popup"
        }
      },
      required: ['target']
    }
  }
},
{
  type: 'function',
  function: {
    name: 'close_current_page',
    description:
      'Close the current tab/page and automatically switch back to another open page if available.',
    parameters: { type: 'object', properties: {} }
  }
}

  
    
];

export default toolsSchema;