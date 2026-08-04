const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const reportsDir = path.join(__dirname, '../reports');

// Ensure reports directory exists
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

// List all .md reports
app.get('/api/reports', (req, res) => {
    try {
        const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
        
        // Sort by modified time descending (newest first)
        const sortedFiles = files.map(file => {
            return {
                name: file,
                time: fs.statSync(path.join(reportsDir, file)).mtime.getTime()
            };
        }).sort((a, b) => b.time - a.time);
        
        res.json({ success: true, files: sortedFiles });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get specific report content
app.get('/api/reports/:filename', (req, res) => {
    try {
        const filePath = path.join(reportsDir, req.params.filename);
        if(!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "File not found" });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ success: true, content });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete specific report
app.delete('/api/reports/:filename', (req, res) => {
    try {
        const filePath = path.join(reportsDir, req.params.filename);
        if(!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "File not found" });
        }
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Run terminal command
app.post('/api/run', (req, res) => {
    let { command } = req.body;
    if (!command) return res.status(400).json({ success: false, error: "No command provided" });
    
    // Auto-prefix for agent commands
    const agentCommands = ['analyze', 'act', 'replay', 'setup', 'chart', 'draw', 'alert', 'alerts', 'drawings', 'clear', 'sweep', 'mcp', 'tools', 'snapshot', 'restore', 'snapshots', 'watchlist'];
    const cmdName = command.trim().split(' ')[0].toLowerCase();
    
    if (agentCommands.includes(cmdName)) {
        command = `node src/index.js ${command}`;
    }

    // Execute command from the root 'trading' directory
    const cwd = path.join(__dirname, '..');
    exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Command error: ${error.message}`);
            return res.status(500).json({ success: false, error: error.message, stdout, stderr });
        }
        res.json({ success: true, stdout, stderr });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`AI Trading Dashboard running at http://localhost:${PORT}`);
});
