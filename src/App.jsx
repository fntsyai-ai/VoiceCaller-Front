import { useState, useEffect, useRef } from 'react'
import io from 'socket.io-client'
import './App.css'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'

function App() {
  const [isCallActive, setIsCallActive] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState('Click to start your conversation')
  const [transcript, setTranscript] = useState([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [activeSection, setActiveSection] = useState('hero')

  const socketRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioContextRef = useRef(null)
  const audioQueueRef = useRef([])
  const isPlayingRef = useRef(false)
  const currentAudioSourceRef = useRef(null)
  const demoSectionRef = useRef(null)

  useEffect(() => {
    // Connect to server with proper CORS configuration
    socketRef.current = io(SERVER_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    })

    socketRef.current.on('connect', () => {
      setIsConnected(true)
      console.log('Connected to server')
    })

    socketRef.current.on('disconnect', () => {
      setIsConnected(false)
      console.log('Disconnected from server')
    })

    socketRef.current.on('status', (message) => {
      setStatus(message)
    })

    socketRef.current.on('transcript', (data) => {
      setTranscript(prev => [...prev, { type: 'user', text: data.text }])
    })

    socketRef.current.on('ai-response', (data) => {
      if (data.complete) {
        setTranscript(prev => {
          const filtered = prev.filter(item => !item.isPartial)
          return [...filtered, { type: 'ai', text: data.text }]
        })
      } else if (data.partial) {
        setTranscript(prev => {
          const lastItem = prev[prev.length - 1]
          if (lastItem && lastItem.type === 'ai' && lastItem.isPartial) {
            return [
              ...prev.slice(0, -1),
              { type: 'ai', text: lastItem.text + ' ' + data.text, isPartial: true }
            ]
          } else {
            return [...prev, { type: 'ai', text: data.text, isPartial: true }]
          }
        })
      } else {
        setTranscript(prev => [...prev, { type: 'ai', text: data.text }])
      }
    })

    socketRef.current.on('audio-response', (audioData) => {
      playAudioResponse(audioData)
    })

    socketRef.current.on('barge-in', () => {
      console.log('🛑 Barge-in detected - stopping audio')
      stopAudioPlayback()
    })

    socketRef.current.on('error', (error) => {
      console.error('Socket error:', error)
      setStatus(`Error: ${error.message}`)
    })

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [])

  const startCall = async () => {
    try {
      console.log('🎤 Requesting microphone access...')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000
        }
      })

      console.log('✅ Microphone access granted')
      setIsCallActive(true)
      setStatus('Call started - AI is listening...')
      setTranscript([])

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()

      // Try to use the best available codec
      let mimeType = 'audio/webm'
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus'
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus'
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4'
        } else {
          console.warn('⚠️ Using default codec, audio/webm not supported')
          mimeType = '' // Use browser default
        }
      }

      console.log('🎵 Using audio format:', mimeType || 'default')

      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      mediaRecorderRef.current = mediaRecorder

      let chunkCount = 0
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socketRef.current) {
          chunkCount++
          if (chunkCount === 1) {
            console.log('📤 Started sending audio chunks to server')
          }
          socketRef.current.emit('audio-stream', event.data)
        }
      }

      mediaRecorder.onerror = (event) => {
        console.error('❌ MediaRecorder error:', event.error)
        setStatus('Error: Recording failed')
      }

      console.log('▶️ Starting MediaRecorder...')
      mediaRecorder.start(250)

      console.log('📡 Emitting call-start event...')
      socketRef.current.emit('call-start')

    } catch (error) {
      console.error('❌ Error starting call:', error)
      setStatus('Error: Could not access microphone - ' + error.message)
    }
  }

  const endCall = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop())
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
    }

    socketRef.current.emit('call-end')
    setIsCallActive(false)
    setStatus('Call ended')
    setIsSpeaking(false)
  }

  const stopAudioPlayback = () => {
    if (currentAudioSourceRef.current) {
      try {
        currentAudioSourceRef.current.stop()
        currentAudioSourceRef.current = null
      } catch (e) {
        // Source might already be stopped
      }
    }

    audioQueueRef.current = []
    isPlayingRef.current = false

    if (audioContextRef.current && audioContextRef.current.state === 'running') {
      audioContextRef.current.close().then(() => {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
      })
    }

    setIsSpeaking(false)
  }

  const playAudioResponse = async (audioData) => {
    try {
      audioQueueRef.current.push(audioData)
      if (!isPlayingRef.current) {
        processAudioQueue()
      }
    } catch (error) {
      console.error('Error queueing audio:', error)
    }
  }

  const processAudioQueue = async () => {
    if (isPlayingRef.current) return
    isPlayingRef.current = true
    setIsSpeaking(true)

    try {
      while (audioQueueRef.current.length > 0) {
        const audioData = audioQueueRef.current.shift()
        const audioBuffer = base64ToArrayBuffer(audioData)
        const decodedAudio = await audioContextRef.current.decodeAudioData(audioBuffer)

        await new Promise((resolve, reject) => {
          const source = audioContextRef.current.createBufferSource()
          source.buffer = decodedAudio
          source.connect(audioContextRef.current.destination)
          currentAudioSourceRef.current = source

          source.onended = () => {
            currentAudioSourceRef.current = null
            resolve()
          }
          source.onerror = reject

          source.start(0)
        })
      }
    } catch (error) {
      console.error('Error playing audio:', error)
    } finally {
      isPlayingRef.current = false
      setIsSpeaking(false)
    }
  }

  const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64)
    const len = binaryString.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes.buffer
  }

  const scrollToDemo = () => {
    demoSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="app">
      {/* Animated Background */}
      <div className="animated-background">
        <div className="network-nodes">
          {[...Array(20)].map((_, i) => (
            <div key={i} className="node" style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 3}s`
            }}></div>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <nav className="navbar">
        <div className="nav-container">
          <div className="logo">
            <div className="logo-icon">
              <div className="pulse-ring"></div>
              <div className="pulse-ring delay-1"></div>
              <div className="pulse-ring delay-2"></div>
              <img src="/logo.png" alt="Voice Call AI" className="logo-image" />
            </div>
            <span className="logo-text">Voice Call AI</span>
          </div>
          <div className="nav-links">
            <a href="#features" className="nav-link">Features</a>
            <a href="#architecture" className="nav-link">Architecture</a>
            <a href="#demo" className="nav-link">Live Demo</a>
            <button onClick={scrollToDemo} className="nav-cta">Try Now</button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-content">
          <div className="connection-badge">
            <div className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></div>
            {isConnected ? 'System Online' : 'Connecting...'}
          </div>

          <h1 className="hero-title">
            Real-Time Voice AI
            <span className="gradient-text"> Without Black Boxes</span>
          </h1>

          <p className="hero-subtitle">
            Build custom voice agents with full control. Cut costs by 70%. Deploy in minutes.
          </p>

          <div className="hero-metrics">
            <div className="metric-card">
              <div className="metric-value">&lt; 1s</div>
              <div className="metric-label">Response Time</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">70%</div>
              <div className="metric-label">Cost Reduction</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">100%</div>
              <div className="metric-label">Full Control</div>
            </div>
          </div>

          <div className="hero-cta">
            <button onClick={scrollToDemo} className="cta-primary">
              Try Live Demo
              <svg className="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </button>
            <a href="#architecture" className="cta-secondary">View Architecture</a>
          </div>
        </div>

        <div className="hero-visual">
          <div className="pulse-container">
            <div className="audio-wave"></div>
            <div className="audio-wave"></div>
            <div className="audio-wave"></div>
            <div className="audio-wave"></div>
            <div className="audio-wave"></div>
          </div>
        </div>
      </section>

      {/* Value Proposition Section */}
      <section id="features" className="value-section">
        <div className="section-header">
          <h2 className="section-title">Why Build Your Own Voice AI?</h2>
          <p className="section-subtitle">Don't pay premiums for black box solutions. Own your infrastructure.</p>
        </div>

        <div className="comparison-grid">
          <div className="comparison-card black-box">
            <div className="card-header">
              <h3>Traditional Platforms</h3>
              <span className="card-badge expensive">$$$$</span>
            </div>
            <ul className="comparison-list">
              <li className="negative">
                <span className="icon">✗</span>
                <span>High per-minute costs</span>
              </li>
              <li className="negative">
                <span className="icon">✗</span>
                <span>Limited customization</span>
              </li>
              <li className="negative">
                <span className="icon">✗</span>
                <span>Vendor lock-in</span>
              </li>
              <li className="negative">
                <span className="icon">✗</span>
                <span>No data ownership</span>
              </li>
              <li className="negative">
                <span className="icon">✗</span>
                <span>Black box operations</span>
              </li>
            </ul>
          </div>

          <div className="comparison-card custom-built highlight">
            <div className="card-header">
              <h3>Custom Built Solution</h3>
              <span className="card-badge affordable">70% Less</span>
            </div>
            <ul className="comparison-list">
              <li className="positive">
                <span className="icon">✓</span>
                <span>Massive cost savings</span>
              </li>
              <li className="positive">
                <span className="icon">✓</span>
                <span>Complete customization</span>
              </li>
              <li className="positive">
                <span className="icon">✓</span>
                <span>No vendor lock-in</span>
              </li>
              <li className="positive">
                <span className="icon">✓</span>
                <span>Full data ownership</span>
              </li>
              <li className="positive">
                <span className="icon">✓</span>
                <span>Transparent operations</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">⚡</div>
            <h3>Streaming Pipeline</h3>
            <p>Real-time STT, LLM, and TTS streaming for instant responses</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🎯</div>
            <h3>Barge-In Support</h3>
            <p>Natural interruptions like real human conversations</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔧</div>
            <h3>Full Customization</h3>
            <p>Modify every aspect of your voice agent's behavior</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📊</div>
            <h3>Data Ownership</h3>
            <p>All conversations and data stored in your control</p>
          </div>
        </div>
      </section>

      {/* Architecture Flow Section */}
      <section id="architecture" className="architecture-section">
        <div className="section-header">
          <h2 className="section-title">How It Works</h2>
          <p className="section-subtitle">End-to-end streaming pipeline for ultra-low latency</p>
        </div>

        <div className="flow-diagram">
          <div className="flow-node user-node">
            <div className="node-icon">🎤</div>
            <div className="node-label">User Speech</div>
            <div className="node-detail">Real-time audio</div>
          </div>

          <div className="flow-connector">
            <div className="connector-line"></div>
            <div className="connector-label">WebSocket Stream</div>
          </div>

          <div className="flow-node stt-node">
            <div className="node-icon">📝</div>
            <div className="node-label">Speech-to-Text</div>
            <div className="node-detail">Deepgram Nova-3</div>
          </div>

          <div className="flow-connector">
            <div className="connector-line"></div>
            <div className="connector-label">Transcription</div>
          </div>

          <div className="flow-node llm-node">
            <div className="node-icon">🧠</div>
            <div className="node-label">LLM Processing</div>
            <div className="node-detail">OpenAI / Gemini</div>
          </div>

          <div className="flow-connector">
            <div className="connector-line"></div>
            <div className="connector-label">Streaming Response</div>
          </div>

          <div className="flow-node tts-node">
            <div className="node-icon">🔊</div>
            <div className="node-label">Text-to-Speech</div>
            <div className="node-detail">ElevenLabs / Cartesia</div>
          </div>

          <div className="flow-connector">
            <div className="connector-line"></div>
            <div className="connector-label">Audio Stream</div>
          </div>

          <div className="flow-node playback-node">
            <div className="node-icon">🎧</div>
            <div className="node-label">Audio Playback</div>
            <div className="node-detail">Real-time playback</div>
          </div>
        </div>

        <div className="tech-highlights">
          <div className="tech-highlight">
            <span className="highlight-number">250ms</span>
            <span className="highlight-text">Audio chunk streaming</span>
          </div>
          <div className="tech-highlight">
            <span className="highlight-number">150ms</span>
            <span className="highlight-text">VAD endpointing</span>
          </div>
          <div className="tech-highlight">
            <span className="highlight-number">Async</span>
            <span className="highlight-text">Non-blocking pipeline</span>
          </div>
        </div>
      </section>

      {/* Live Demo Section */}
      <section id="demo" className="demo-section" ref={demoSectionRef}>
        <div className="section-header">
          <h2 className="section-title">Experience It Live</h2>
          <p className="section-subtitle">Try the AI voice agent right now in your browser</p>
        </div>

        <div className="demo-container">
          <div className="demo-visual">
            <div className="call-button-wrapper">
              {!isCallActive ? (
                <button
                  className="call-button start"
                  onClick={startCall}
                  disabled={!isConnected}
                >
                  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span>Start Call</span>
                </button>
              ) : (
                <button className="call-button end" onClick={endCall}>
                  <svg className="icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span>End Call</span>
                </button>
              )}

              {isSpeaking && (
                <div className="speaking-indicator">
                  <div className="speaking-wave"></div>
                  <div className="speaking-wave"></div>
                  <div className="speaking-wave"></div>
                </div>
              )}
            </div>

            <p className="demo-status">{status}</p>

            {isCallActive && (
              <div className="pipeline-visual">
                <div className="pipeline-step active">
                  <div className="step-dot"></div>
                  <span>Listening</span>
                </div>
                <div className={`pipeline-step ${isSpeaking ? 'active' : ''}`}>
                  <div className="step-dot"></div>
                  <span>Processing</span>
                </div>
                <div className={`pipeline-step ${isSpeaking ? 'active' : ''}`}>
                  <div className="step-dot"></div>
                  <span>Speaking</span>
                </div>
              </div>
            )}
          </div>

          {transcript.length > 0 && (
            <div className="transcript-panel">
              <h3 className="transcript-title">Live Transcript</h3>
              <div className="transcript-messages">
                {transcript.map((msg, idx) => (
                  <div key={idx} className={`message ${msg.type} ${msg.isPartial ? 'partial' : ''}`}>
                    <span className="message-label">{msg.type === 'user' ? 'You' : 'AI'}:</span>
                    <span className="message-text">{msg.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Metrics Section */}
      <section className="metrics-section">
        <div className="section-header">
          <h2 className="section-title">The Numbers Don't Lie</h2>
          <p className="section-subtitle">Real performance metrics from production deployments</p>
        </div>

        <div className="metrics-showcase">
          {/* Main Hero Pricing Card */}
          <div className="pricing-hero">
            <div className="pricing-comparison-large">
              <div className="pricing-side traditional-side">
                <div className="pricing-label">Traditional Platforms</div>
                <div className="pricing-amount expensive">$0.25</div>
                <div className="pricing-unit">per minute</div>
                <div className="pricing-calculation">
                  <div className="calc-line">1,000 min = <strong>$250</strong></div>
                  <div className="calc-line">10,000 min = <strong>$2,500</strong></div>
                  <div className="calc-line">100,000 min = <strong>$25,000</strong></div>
                </div>
              </div>

              <div className="vs-divider">
                <div className="vs-circle">
                  <span>VS</span>
                </div>
                <div className="savings-badge">
                  <div className="savings-percentage">68%</div>
                  <div className="savings-label">SAVINGS</div>
                </div>
              </div>

              <div className="pricing-side custom-side">
                <div className="pricing-label">Our Solution</div>
                <div className="pricing-amount affordable">$0.08</div>
                <div className="pricing-unit">per minute</div>
                <div className="pricing-calculation savings">
                  <div className="calc-line">1,000 min = <strong>$80</strong> <span className="save">Save $170</span></div>
                  <div className="calc-line">10,000 min = <strong>$800</strong> <span className="save">Save $1,700</span></div>
                  <div className="calc-line">100,000 min = <strong>$8,000</strong> <span className="save">Save $17,000</span></div>
                </div>
              </div>
            </div>

            <div className="roi-callout">
              💡 Scale your voice AI without breaking the bank. At 10K minutes/month, you save <strong>$20,400 per year</strong>.
            </div>
          </div>

          {/* Side Metrics */}
          <div className="side-metrics">
            <div className="metric-box">
              <div className="metric-box-icon">⚡</div>
              <div className="metric-box-title">Lightning Fast</div>
              <div className="metric-box-value">&lt; 1s</div>
              <div className="metric-box-detail">End-to-end response time</div>
              <div className="latency-breakdown">
                <div className="latency-item">
                  <span className="dot stt"></span>
                  <span>STT: 200ms</span>
                </div>
                <div className="latency-item">
                  <span className="dot llm"></span>
                  <span>LLM: 400ms</span>
                </div>
                <div className="latency-item">
                  <span className="dot tts"></span>
                  <span>TTS: 300ms</span>
                </div>
              </div>
            </div>

            <div className="metric-box">
              <div className="metric-box-icon">🎯</div>
              <div className="metric-box-title">Rock Solid</div>
              <div className="metric-box-value">99.9%</div>
              <div className="metric-box-detail">Uptime reliability</div>
              <div className="uptime-bar">
                <div className="uptime-fill"></div>
              </div>
            </div>

            <div className="metric-box highlight">
              <div className="customization-visual">
                <svg className="progress-ring" viewBox="0 0 100 100">
                  <circle
                    className="progress-ring-bg"
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="rgba(125, 249, 255, 0.1)"
                    strokeWidth="8"
                  />
                  <circle
                    className="progress-ring-circle full"
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="url(#gradient2)"
                    strokeWidth="8"
                    strokeDasharray="251.2"
                    strokeDashoffset="0"
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                  <defs>
                    <linearGradient id="gradient2" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#191970" />
                      <stop offset="100%" stopColor="#7DF9FF" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="progress-center">
                  <div className="metric-box-icon-large">🔧</div>
                </div>
              </div>
              <div className="metric-box-title">100% Customizable</div>
              <div className="metric-box-detail">Full control over every component</div>
              <div className="customization-features">
                <div className="feature-tag">Custom LLM</div>
                <div className="feature-tag">Your TTS</div>
                <div className="feature-tag">Own Data</div>
                <div className="feature-tag">Full Logic</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Tech Stack Section */}
      <section className="tech-stack-section">
        <div className="section-header">
          <h2 className="section-title">Built With Best-in-Class AI Services</h2>
          <p className="section-subtitle">Choose your own providers or use our defaults</p>
        </div>

        <div className="stack-grid">
          <div className="stack-category">
            <h3 className="category-title">Speech-to-Text</h3>
            <div className="stack-items">
              <div className="stack-item">
                <div className="stack-logo">🎤</div>
                <span>Deepgram Nova-3</span>
              </div>
            </div>
          </div>

          <div className="stack-category">
            <h3 className="category-title">Large Language Models</h3>
            <div className="stack-items">
              <div className="stack-item">
                <div className="stack-logo">🤖</div>
                <span>OpenAI GPT-4o</span>
              </div>
              <div className="stack-item">
                <div className="stack-logo">✨</div>
                <span>Google Gemini</span>
              </div>
            </div>
          </div>

          <div className="stack-category">
            <h3 className="category-title">Text-to-Speech</h3>
            <div className="stack-items">
              <div className="stack-item">
                <div className="stack-logo">🔊</div>
                <span>ElevenLabs</span>
              </div>
              <div className="stack-item">
                <div className="stack-logo">🎵</div>
                <span>Cartesia</span>
              </div>
            </div>
          </div>

          <div className="stack-category">
            <h3 className="category-title">Infrastructure</h3>
            <div className="stack-items">
              <div className="stack-item">
                <div className="stack-logo">⚙️</div>
                <span>Node.js + Socket.io</span>
              </div>
              <div className="stack-item">
                <div className="stack-logo">⚛️</div>
                <span>React + Vite</span>
              </div>
            </div>
          </div>
        </div>

        <div className="stack-note">
          <p>✨ All components are modular and swappable. Use your preferred providers.</p>
        </div>
      </section>

      {/* CTA Footer */}
      <section className="cta-footer">
        <div className="cta-content">
          <h2 className="cta-title">Ready to Build Your Own Voice AI?</h2>
          <p className="cta-subtitle">Stop paying premium prices for black box solutions. Take control today.</p>

          <div className="cta-buttons">
            <button onClick={scrollToDemo} className="cta-button primary">
              Try Live Demo
            </button>
            <button className="cta-button secondary">
              View Documentation
            </button>
          </div>

          <div className="cta-stats">
            <div className="cta-stat">
              <strong>Sub-second</strong>
              <span>response times</span>
            </div>
            <div className="cta-stat">
              <strong>70% less</strong>
              <span>running costs</span>
            </div>
            <div className="cta-stat">
              <strong>100%</strong>
              <span>data ownership</span>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="logo-icon small">
                <div className="pulse-ring"></div>
                <img src="/logo.png" alt="Voice Call AI" className="logo-image" />
              </div>
              <span className="logo-text">Voice Call AI</span>
            </div>
            <p>Real-time voice AI infrastructure you own and control.</p>
          </div>

          <div className="footer-links">
            <div className="footer-column">
              <h4>Product</h4>
              <a href="#features">Features</a>
              <a href="#architecture">Architecture</a>
              <a href="#demo">Live Demo</a>
            </div>
            <div className="footer-column">
              <h4>Resources</h4>
              <a href="#">Documentation</a>
              <a href="#">GitHub</a>
              <a href="#">API Reference</a>
            </div>
            <div className="footer-column">
              <h4>Company</h4>
              <a href="#">About</a>
              <a href="#">Contact</a>
              <a href="#">Blog</a>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <p>&copy; 2026 Voice Call AI. Built with full transparency and control.</p>
        </div>
      </footer>
    </div>
  )
}

export default App
