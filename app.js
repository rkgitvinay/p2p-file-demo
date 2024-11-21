// Fetch network status and display nodes and files
async function fetchNetworkStatus() {
  try {
    const response = await fetch('http://localhost:3000/network-status')
    const data = await response.json()
    displayNodes(data.nodes)
  } catch (error) {
    console.error('Error fetching network status:', error)
  }
}

// Display nodes and their files in the UI
function displayNodes(nodes) {
  const nodeList = document.getElementById('nodeList')
  nodeList.innerHTML = ''

  nodes.forEach(node => {
    const nodeElement = document.createElement('div')
    nodeElement.classList.add('node')
    nodeElement.innerHTML = `
      <h3>Node ID: ${node.id} ${node.isLocal ? '(Local)' : ''}</h3>
      <p>Address: ${node.address}</p>
      <p>Last Seen: ${new Date(node.lastSeen).toLocaleString()}</p>
      <h4>Files:</h4>
      <ul class="file-list">
        ${node.files.length > 0 ? node.files.map(file => `
          <li class="file-item">
            ${file} 
            <button onclick="downloadFile('${node.id}', '${file}')">Download</button>
          </li>
        `).join('') : '<li>No files available</li>'}
      </ul>
    `
    nodeList.appendChild(nodeElement)
  })
}

// Download a file from a specific node
async function downloadFile(nodeId, filename) {
  const link = document.createElement('a')
  link.href = `http://localhost:3000/download/${nodeId}/${filename}`
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
