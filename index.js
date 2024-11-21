import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { mdns } from '@libp2p/mdns'
import { identify } from '@libp2p/identify'
import { multiaddr } from '@multiformats/multiaddr'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import multer from 'multer'
import bodyParser from 'body-parser'
import cors from 'cors'
import { pipeline } from 'stream/promises'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { bootstrap } from '@libp2p/bootstrap'
import { webTransport } from '@libp2p/webtransport'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { yamux } from '@chainsafe/libp2p-yamux'
import * as filters from '@libp2p/websockets/filters'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'

const PUBSUB_PEER_DISCOVERY = 'browser-peer-discovery'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Track available files and nodes across the network
const networkFiles = new Map()
const networkNodes = new Map()

const storage = multer.diskStorage({
  destination: './shared',
  filename: (req, file, cb) => {
    cb(null, file.originalname)
  }
})

const upload = multer({ storage })
const app = express()
app.use(cors())
app.use(bodyParser.json())
app.use(express.static(__dirname))

const sharedDir = path.join(__dirname, 'shared')
if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir)
}

async function startNode() {
  const peerId = await createEd25519PeerId()
  
  // Create the libp2p node with enhanced configuration
  const node = await createLibp2p({
    addresses: {
      listen: [ 
        // 👇 Listen for webRTC connection
        '/webrtc',
        '/ip4/0.0.0.0/tcp/0/ws',
        '/ip4/0.0.0.0/tcp/0',
      ],
    },
    transports: [
      webSockets({
        // Allow all WebSocket connections inclusing without TLS
        filter: filters.all,
      }),
      webTransport(),
      webRTC(),
      tcp(),
      // // 👇 Required to create circuit relay reservations in order to hole punch browser-to-browser WebRTC connections
      circuitRelayTransport({
        discoverRelays: 1,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      // Allow private addresses for local testing
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      bootstrap({
        list: [
          '/ip4/35.200.242.137/tcp/9001/ws/p2p/12D3KooWPyFNFu2n9nN7crWrzFpXfhpULWgY42DNJ9szSu4Lo7gx',
          '/ip4/35.200.242.137/tcp/9002/p2p/12D3KooWPyFNFu2n9nN7crWrzFpXfhpULWgY42DNJ9szSu4Lo7gx'
        ],
      }),
      pubsubPeerDiscovery({
        interval: 1000,
        topics: [PUBSUB_PEER_DISCOVERY],
      }),
    ],
    services: {
      pubsub: gossipsub({
        emitSelf: true
      }),
      identify: identify(),
    },
  })

  const connectedPeers = new Set()
  const nodeId = node.peerId.toString()
  
  // Initialize this node in the network nodes map
  networkNodes.set(nodeId, {
    id: nodeId,
    files: new Set(),
    address: node.getMultiaddrs().map(ma => ma.toString()),
    lastSeen: Date.now(),
    isLocal: true,
    status: 'active'
  })

  // Enhanced peer discovery handler
  node.addEventListener('peer:discovery', async (evt) => {
    const peerId = evt.detail.id.toString()
    console.log('Discovered peer:', peerId)
    
    if (!networkNodes.has(peerId)) {
      networkNodes.set(peerId, {
        id: peerId,
        files: new Set(),
        address: [],
        lastSeen: Date.now(),
        isLocal: false,
        status: 'discovered',
        connectionAttempts: 0
      })
    }
    
    const peerInfo = networkNodes.get(peerId)
    
    try {
      const peerData = await node.peerStore.get(evt.detail.id)
      const peerAddrs = peerData?.addresses || []
      
      if (peerAddrs.length > 0) {
        const ma = peerAddrs[0].multiaddr
        await node.dial(ma);
      } 
    } catch (err) {
      peerInfo.connectionAttempts++
      peerInfo.lastConnectionAttempt = Date.now()
      peerInfo.lastError = err.message
      console.error(`Failed to connect to peer ${peerId}:`, err.message)
    }
    
    networkNodes.set(peerId, peerInfo)
  })

  // Enhanced connection handler
  node.addEventListener('peer:connect', async (evt) => {
    const peerId = evt.detail.toString()
    connectedPeers.add(peerId)
    console.log('Connected to peer:', peerId)
  })

  // Handle file announcements
  await node.services.pubsub.subscribe('file-share', async (msg) => {
    try {
      const data = JSON.parse(msg.data.toString())
      if (data.type === 'file-available') {
        const peerInfo = {
          peerId: msg.from,
          timestamp: data.timestamp
        }
        
        networkFiles.set(data.filename, {
          ...data,
          peers: [...(networkFiles.get(data.filename)?.peers || []), peerInfo]
        })
        
        // Update node's file list
        const nodeInfo = networkNodes.get(msg.from)
        if (nodeInfo) {
          nodeInfo.files = nodeInfo.files || new Set()
          nodeInfo.files.add(data.filename)
        }
        
        console.log('\nNew file available in the network:', data.filename)
      }
    } catch (err) {
      console.error('Error processing file announcement:', err)
    }
  })

  // API Endpoints
  app.post('/share', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    try {
      const fileInfo = {
        type: 'file-available',
        filename: req.file.filename,
        size: req.file.size,
        timestamp: Date.now(),
        nodeId
      }

      // Add to local node's files
      const nodeInfo = networkNodes.get(nodeId)
      if (nodeInfo) {
        nodeInfo.files = nodeInfo.files || new Set()
        nodeInfo.files.add(req.file.filename)
      }

      await node.services.pubsub.publish('file-share', 
        Buffer.from(JSON.stringify(fileInfo))
      )
      res.json({ message: 'File shared successfully', fileInfo })
    } catch (err) {
      console.error('Error publishing file info:', err)
      res.status(500).json({ error: 'Failed to announce file' })
    }
  })

  app.get('/network-status', (req, res) => {
    const nodesInfo = Array.from(networkNodes.entries()).map(([id, info]) => ({
      id,
      address: info.address,
      files: Array.from(info.files || []),
      lastSeen: info.lastSeen,
      isLocal: id === nodeId,
      isConnected: connectedPeers.has(id)
    }))

    res.json({
      nodes: nodesInfo,
      currentNode: nodeId,
      connectedPeers: Array.from(connectedPeers)
    })
  })

  app.get('/download/:nodeId/:filename', async (req, res) => {
    const { nodeId: targetNodeId, filename } = req.params
    
    try {
      // If file is local, serve directly
      if (targetNodeId === nodeId) {
        const filePath = path.join(sharedDir, filename)
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' })
        }
        return res.download(filePath)
      }
      
      // If file is remote, check if we have connection to the target node
      if (!connectedPeers.has(targetNodeId)) {
        return res.status(404).json({ error: 'Node not connected' })
      }
      
      // Request file from target node (implementation needed)
      const filePath = path.join(sharedDir, filename)
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' })
      }
      res.download(filePath)
    } catch (err) {
      console.error('Error downloading file:', err)
      res.status(500).json({ error: 'Failed to download file' })
    }
  })

  const port = process.env.PORT || 3000
  app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${port}`)
    console.log('Node addresses:', node.getMultiaddrs().map(ma => ma.toString()))
  })

  await node.start()
  console.log('Node started with ID:', nodeId)
  return node
}

startNode().catch(console.error)