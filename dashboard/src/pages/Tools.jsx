import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import { Wrench, ChevronRight } from 'lucide-react';
import { Chip, TextField } from '../components/ui';

export default function Tools() {
  const { data: catalog, isLoading, isError } = useQuery({ queryKey: ['tools'], queryFn: api.getTools, staleTime: 30000 });
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedTool, setSelectedTool] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const categories = catalog?.categories || [];

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
      <header className="tools-header">
        <div className="tools-header-left">
          <h2><Wrench size={28} aria-hidden="true" /> Tools</h2>
          <span className="tools-count"><span className="tabular">{allTools.length}</span> available</span>
        </div>
        {/* Category chips */}
        <div className="tools-cats" role="group" aria-label="Filter by category">
          <Chip
            selected={!selectedCat}
            onClick={() => { setSelectedCat(null); setSelectedTool(null); }}
          >
            All
          </Chip>
          {categories.map(cat => (
            <Chip
              key={cat.name}
              selected={selectedCat === cat.name}
              count={cat.tools.length}
              onClick={() => { setSelectedCat(cat.name); setSelectedTool(null); }}
            >
              {cat.name}
            </Chip>
          ))}
        </div>
      </header>

      {/* Split pane */}
      <div className="tools-split">
        {/* Left: Tool list */}
        <nav className="tools-list-pane" aria-label="Tool list">
          {/* Search */}
          <div className="tools-search">
            <TextField
              id="tools-search"
              aria-label="Search tools"
              placeholder="Search tools"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onClear={() => setSearchQuery('')}
              autoComplete="off"
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
                    type="button"
                    onClick={() => setSelectedTool(tool.name)}
                    aria-current={selectedTool === tool.name ? 'true' : undefined}
                    className={`tools-list-item${selectedTool === tool.name ? ' active' : ''}`}
                  >
                    <Wrench size={16} aria-hidden="true" />
                    <span className="tools-item-name">{tool.name}</span>
                    <ChevronRight size={16} aria-hidden="true" className="tools-item-arrow" />
                  </button>
                ))}
              </div>
            ))}
            {displayedTools.length === 0 && (
              <div className="tools-empty">
                {isLoading ? 'Loading tools…'
                  : isError ? "Couldn't load the tools. Check the AbleSpeak server is running, then reload."
                  : allTools.length === 0 ? 'No tools are registered.'
                  : 'No tools match your filter.'}
              </div>
            )}
          </div>
        </nav>

        {/* Right: Tool detail */}
        <section className="tools-detail-pane" aria-label="Tool details" aria-live="polite">
          {activeTool ? (
            <div className="tools-detail-scroll">
              {/* Tool header */}
              <div className="tools-detail-head">
                <div className="tools-detail-icon" aria-hidden="true">
                  <Wrench size={24} />
                </div>
                <div>
                  <h3 className="tools-detail-name">{activeTool.name}</h3>
                  <p className="tools-detail-cat">{activeTool.category}</p>
                  <p className="tools-detail-runs">
                    {activeTool.needsExtension ? 'Needs the Chrome extension' : 'Works without the Chrome extension'}
                  </p>
                </div>
              </div>

              {/* Description */}
              {activeTool.jsonSchema?.description && (
                <div className="tools-detail-section">
                  <h4 className="tools-section-label">Description</h4>
                  <p className="tools-detail-desc">{activeTool.jsonSchema.description}</p>
                </div>
              )}

              {/* Parameters */}
              {activeTool.jsonSchema?.parameters?.properties && (
                <div className="tools-detail-section">
                  <h4 className="tools-section-label">Parameters</h4>
                  <div className="tools-params">
                    {Object.entries(activeTool.jsonSchema.parameters.properties).map(([name, schema]) => (
                      <div key={name} className="tools-param">
                        <div className="tools-param-head">
                          <code className="tools-param-name">{name}</code>
                          <span className="tools-param-type">{schema.type || 'any'}</span>
                          {(activeTool.jsonSchema.parameters.required || []).includes(name) && (
                            <span className="tag">required</span>
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
                <h4 className="tools-section-label">Function schema</h4>
                <pre className="tools-code-block">
                  {activeTool.jsonSchema
                    ? JSON.stringify(activeTool.jsonSchema, null, 2)
                    : `{ "name": "${activeTool.name}" }`}
                </pre>
              </div>

              {/* Code */}
              {activeTool.code && (
                <div className="tools-detail-section">
                  <h4 className="tools-section-label">Execution code</h4>
                  <pre className="tools-code-block">{activeTool.code}</pre>
                </div>
              )}

              {/* YAML */}
              {activeTool.yaml && (
                <div className="tools-detail-section">
                  <h4 className="tools-section-label">YAML definition</h4>
                  <pre className="tools-code-block">{activeTool.yaml}</pre>
                </div>
              )}
            </div>
          ) : (
            <div className="tools-detail-empty">
              <Wrench size={40} aria-hidden="true" />
              <p>Choose a tool to see its details.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
