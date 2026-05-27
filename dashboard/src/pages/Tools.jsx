import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import { Wrench, ChevronRight, Search, Filter } from 'lucide-react';

export default function Tools() {
  const { data: library } = useQuery({ queryKey: ['library'], queryFn: api.getLibrary, staleTime: 30000 });
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedTool, setSelectedTool] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const categories = library?.categories || [];

  // Flatten all tools with their category info
  const allTools = [];
  categories.forEach(cat => {
    cat.tools.forEach(tool => {
      allTools.push({ ...tool, category: cat.name });
    });
  });

  // Filter by category
  let displayedTools = selectedCat
    ? allTools.filter(t => t.category === selectedCat)
    : allTools;

  // Filter by search
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    displayedTools = displayedTools.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.jsonSchema?.description || '').toLowerCase().includes(q)
    );
  }

  const activeTool = selectedTool
    ? allTools.find(t => t.name === selectedTool)
    : null;

  // Group tools by category for display
  const grouped = {};
  displayedTools.forEach(t => {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  });

  return (
    <div className="tools-page">
      {/* Header */}
      <div className="tools-header">
        <div className="tools-header-left">
          <h2>Tools</h2>
          <span className="tools-count">{allTools.length} available</span>
        </div>
        {/* Category pills */}
        <div className="tools-cats">
          <button
            onClick={() => { setSelectedCat(null); setSelectedTool(null); }}
            className={`tools-cat-pill${!selectedCat ? ' active' : ''}`}
          >
            All
          </button>
          {categories.map(cat => (
            <button
              key={cat.name}
              onClick={() => { setSelectedCat(cat.name); setSelectedTool(null); }}
              className={`tools-cat-pill${selectedCat === cat.name ? ' active' : ''}`}
            >
              {cat.name}
              <span className="tools-cat-count">{cat.tools.length}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Split pane */}
      <div className="tools-split">
        {/* Left: Tool list */}
        <div className="tools-list-pane">
          {/* Search */}
          <div className="tools-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Search tools..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Tool list */}
          <div className="tools-list-scroll">
            {Object.entries(grouped).map(([cat, tools]) => (
              <div key={cat} className="tools-group">
                {!selectedCat && (
                  <div className="tools-group-label">{cat}</div>
                )}
                {tools.map(tool => (
                  <button
                    key={`${tool.category}-${tool.name}`}
                    onClick={() => setSelectedTool(tool.name)}
                    className={`tools-list-item${selectedTool === tool.name ? ' active' : ''}`}
                  >
                    <Wrench size={13} />
                    <span className="tools-item-name">{tool.name}</span>
                    <ChevronRight size={12} className="tools-item-arrow" />
                  </button>
                ))}
              </div>
            ))}
            {displayedTools.length === 0 && (
              <div className="tools-empty">No tools match your filter</div>
            )}
          </div>
        </div>

        {/* Right: Tool detail */}
        <div className="tools-detail-pane">
          {activeTool ? (
            <div className="tools-detail-scroll">
              {/* Tool header */}
              <div className="tools-detail-head">
                <div className="tools-detail-icon">
                  <Wrench size={20} />
                </div>
                <div>
                  <h3 className="tools-detail-name">{activeTool.name}</h3>
                  <span className="tools-detail-cat">{activeTool.category}</span>
                </div>
              </div>

              {/* Description */}
              {activeTool.jsonSchema?.description && (
                <div className="tools-detail-section">
                  <div className="tools-section-label">Description</div>
                  <p className="tools-detail-desc">{activeTool.jsonSchema.description}</p>
                </div>
              )}

              {/* Parameters */}
              {activeTool.jsonSchema?.parameters?.properties && (
                <div className="tools-detail-section">
                  <div className="tools-section-label">Parameters</div>
                  <div className="tools-params">
                    {Object.entries(activeTool.jsonSchema.parameters.properties).map(([name, schema]) => (
                      <div key={name} className="tools-param">
                        <div className="tools-param-head">
                          <code className="tools-param-name">{name}</code>
                          <span className="tools-param-type">{schema.type || 'any'}</span>
                          {(activeTool.jsonSchema.parameters.required || []).includes(name) && (
                            <span className="tools-param-req">required</span>
                          )}
                        </div>
                        {schema.description && (
                          <div className="tools-param-desc">{schema.description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* JSON Schema */}
              <div className="tools-detail-section">
                <div className="tools-section-label">Function Schema</div>
                <pre className="tools-code-block">
                  {activeTool.jsonSchema
                    ? JSON.stringify(activeTool.jsonSchema, null, 2)
                    : `{ "name": "${activeTool.name}" }`}
                </pre>
              </div>

              {/* Code */}
              {activeTool.code && (
                <div className="tools-detail-section">
                  <div className="tools-section-label">Execution Code</div>
                  <pre className="tools-code-block">{activeTool.code}</pre>
                </div>
              )}

              {/* YAML */}
              {activeTool.yaml && (
                <div className="tools-detail-section">
                  <div className="tools-section-label">YAML Definition</div>
                  <pre className="tools-code-block">{activeTool.yaml}</pre>
                </div>
              )}
            </div>
          ) : (
            <div className="tools-detail-empty">
              <Wrench size={40} />
              <p>Select a tool to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
