import { GoogleGenAI, Type } from '@google/genai';

// IMPORTANT: Do NOT commit API keys to a public repository in a real production app.
// For the purpose of this demonstration in the AI Studio environment, we are defining
// it directly or expecting it to be provided by the environment.
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || ''; 

// Configuration 
const CONFIG = {
    states: ['GREETING', 'VERIFY', 'WAIT_INFO', 'RESCHED', 'DONE', 'ERROR'],
    delayMinutes: 0, // Mock delay
    appointment: {
        id: 'APP-123',
        time: '3:00 PM',
        provider: 'Dr. Lee',
        doctorId: 'dr_lee'
    }
};

// Tool schemas for Gemini Live interactions
const checkInToolDescription = {
    name: 'completeCheckIn',
    description: 'Completes checking in the patient to their appointment.',
    parameters: {
        type: Type.OBJECT,
        properties: {
             appointmentId: {
                 type: Type.STRING,
                 description: 'The unique appointment ID'
             }
        },
        required: ['appointmentId']
    }
};

const getUpcomingAppointmentsToolDescription = {
    name: 'getUpcomingAppointments',
    description: 'Looks up the patient\'s next appointment.',
    parameters: {
        type: Type.OBJECT,
        properties: {
             name: {
                 type: Type.STRING,
                 description: 'The patient\'s full name'
             },
             dob: {
                 type: Type.STRING,
                 description: 'The patient\'s date of birth in YYYY-MM-DD format (if possible) or descriptive string.'
             }
        },
        required: ['name', 'dob']
    }
};

const getWaitStatusToolDescription = {
    name: 'getWaitStatus',
    description: 'Gets the current wait status in minutes.',
    parameters: {
        type: Type.OBJECT,
        properties: {
             appointmentId: {
                 type: Type.STRING,
                 description: 'The unique appointment ID'
             }
        },
        required: ['appointmentId']
    }
};

const getAvailableSlotsToolDescription = {
    name: 'getAvailableSlots',
    description: 'Retrieves available appointment slots for rescheduling.',
    parameters: {
        type: Type.OBJECT,
        properties: {
             doctorId: {
                 type: Type.STRING,
                 description: 'The provider or doctor ID'
             },
             fromDate: {
                 type: Type.STRING,
                 description: 'Search for appointments on or after this date (YYYY-MM-DD)'
             }
        },
        required: ['doctorId', 'fromDate']
    }
};

const rescheduleAppointmentToolDescription = {
    name: 'rescheduleAppointment',
    description: 'Reschedules the appointment to a new date and time.',
    parameters: {
        type: Type.OBJECT,
        properties: {
             appointmentId: {
                 type: Type.STRING,
                 description: 'The unique appointment ID'
             },
             newDatetime: {
                 type: Type.STRING,
                 description: 'The new appointment date and time in RFC3339 format.'
             }
        },
        required: ['appointmentId', 'newDatetime']
    }
};


class AssistantApp {
    constructor() {
        this.currentState = 'GREETING';
        this.isSessionActive = false;
        
        // DOM Elements
        this.progressBar = document.getElementById('progress-bar');
        this.tooltip = document.getElementById('tooltip');
        this.assistantCaption = document.getElementById('assistant-caption');
        this.userCaption = document.getElementById('user-caption');
        this.micBtn = document.getElementById('mic-btn');
        this.micContainer = document.querySelector('.mic-container');
        this.muteInBtn = document.getElementById('mute-in-btn');
        this.muteOutBtn = document.getElementById('mute-out-btn');
        this.retryBtn = document.getElementById('retry-btn');

        // Gemini AI Components
        this.ai = new GoogleGenAI({ apiKey: API_KEY, httpOptions: { baseUrl: "https://generativelanguage.googleapis.com" } });
        this.session = null;
        this.audioContext = null;
        this.audioStream = null;
        this.gainNode = null;

        // Load persisted mute states
        this.muteIn = localStorage.getItem('zerowait_mute_in') === 'true';
        this.muteOut = localStorage.getItem('zerowait_mute_out') === 'true';
        
        this.textBuffer = ""; // Buffer for streaming text parsing

        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.applyMuteUI();
        this.updateUI();
        
        // Initial setup prompt
        this.assistantCaption.textContent = "Assistant: Hello! I'm initializing your secure session. Click the microphone when you are ready.";
    }

    formatTime12Hour(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return isoString; // Fallback if invalid
        let hours = date.getHours();
        let minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12; 
        minutes = minutes < 10 ? '0' + minutes : minutes;
        return `${hours}:${minutes} ${ampm}`;
    }

    setupEventListeners() {
        this.micBtn.addEventListener('click', async () => {
             if (this.isSessionActive) {
                await this.stopSession();
             } else {
                 // The connection requires an initial user interaction.
                 if(!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
                 }
                 if(this.audioContext.state === 'suspended') {
                     await this.audioContext.resume();
                 }
                 
                await this.startLiveSession();
             }
        });
        
        const logo = document.querySelector('.logo');
        if(logo) logo.addEventListener('click', () => location.reload());
        if(this.retryBtn) this.retryBtn.addEventListener('click', () => location.reload());

        if (this.muteInBtn) {
            this.muteInBtn.addEventListener('click', () => {
                this.muteIn = !this.muteIn;
                localStorage.setItem('zerowait_mute_in', this.muteIn);
                this.applyMuteUI();
            });
        }

        if (this.muteOutBtn) {
            this.muteOutBtn.addEventListener('click', () => {
                this.muteOut = !this.muteOut;
                localStorage.setItem('zerowait_mute_out', this.muteOut);
                this.applyMuteUI();
                if (this.gainNode) {
                     this.gainNode.gain.value = this.muteOut ? 0 : 1;
                }
            });
        }
    }

    applyMuteUI() {
        if (this.muteInBtn) {
             const onIcon = this.muteInBtn.querySelector('.icon-mic-on');
             const offIcon = this.muteInBtn.querySelector('.icon-mic-off');
             if (this.muteIn) {
                 this.muteInBtn.classList.add('muted');
                 if(onIcon) onIcon.classList.add('hidden');
                 if(offIcon) offIcon.classList.remove('hidden');
             } else {
                 this.muteInBtn.classList.remove('muted');
                 if(onIcon) onIcon.classList.remove('hidden');
                 if(offIcon) offIcon.classList.add('hidden');
             }
        }
        if (this.muteOutBtn) {
             const onIcon = this.muteOutBtn.querySelector('.icon-vol-on');
             const offIcon = this.muteOutBtn.querySelector('.icon-vol-off');
             if (this.muteOut) {
                 this.muteOutBtn.classList.add('muted');
                 if(onIcon) onIcon.classList.add('hidden');
                 if(offIcon) offIcon.classList.remove('hidden');
             } else {
                 this.muteOutBtn.classList.remove('muted');
                 if(onIcon) onIcon.classList.remove('hidden');
                 if(offIcon) offIcon.classList.add('hidden');
             }
        }
    }

    async startLiveSession() {
        if (!API_KEY) {
             console.error("VITE_GEMINI_API_KEY is not defined.");
             this.handleAssistantResponse({ ui_state: 'ERROR', text: 'API Key is missing. Please check your environment variables.'});
             return;
        }

        try {
            this.assistantCaption.textContent = "Connecting to Assistant...";
            
            // 1. Get user mic access
            try {
                this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                } });
            } catch(e) {
                 this.assistantCaption.textContent = "Microphone access denied. Please allow microphone access to proceed.";
                 console.error("Mic access error", e);
                 return;
            }

            // 2. Initialize Gemini Live Session
            this.session = await this.ai.clients.createLiveSession({
                 model: 'models/gemini-2.0-flash-exp', // Or appropriately configured live model
                 systemInstruction: {
                      parts: [{
                           text: `You are “zerowait doctor assistant,” the voice-only front desk for a medical clinic.
You must be highly conversational, empathetic, and customer-service oriented.
Do not act like a rigid robot. If the patient asks an off-script question, answer it helpfully while guiding them back.

──────── PRIMARY JOURNEY ────────
1. Greet the patient warmly and start listening.
2. Capture the patient’s FULL LEGAL NAME and DATE OF BIRTH naturally in conversation.
   • If a name or DOB is unclear, politely ask for clarification.
3. Look up the patient’s next appointment using getUpcomingAppointments.
4. Inform them of their wait status using getWaitStatus.
5. If they are late or need to move their appointment, use getAvailableSlots to suggest two sensible new times (the first slot ≥ 30 min later plus one later option) and reschedule on their choice using rescheduleAppointment.
6. Confirm check-in (completeCheckIn tool) or reschedule, ask whether they need anything else, then politely sign out.

──────── UI CONTRACT & DIRECTIVES (drives the front-end) ────────
• Start every reply with exactly ONE line of JSON followed by a newline:
  {"ui_state":"VERIFY","tooltip":"Identity confirmed"}
  – Allowed ui_state values: GREETING, LISTENING, VERIFY, WAIT_INFO, RESCHED, DONE, ERROR  
  – tooltip is OPTIONAL and may only be:
    Identity confirmed | Doctor delay X | Zero wait | Offering new times | Checked in | Rescheduled | Error
• "START OVER": If the user says "start over" or "cancel", output {"ui_state":"GREETING"} to reset the UI, and respond warmly.
• SIGN-OFF: When the user declines further help and you say goodbye, you MUST output {"ui_state":"DONE"}.
• ERROR: If a tool response indicates a failure or error, you MUST output {"ui_state":"ERROR","tooltip":"Error"} and apologize naturally.
• After the JSON tag, speak your user-facing sentence(s), each prefixed exactly with **Assistant:**.
• Use 12-hour times with AM/PM (e.g., 3 : 45 PM).  
• Never reveal inner reasoning, implementation notes, or raw JSON outside the single tag.  
• No markdown formatting.`
                      }]
                 },
                 tools: [
                      {
                            functionDeclarations: [
                                 getUpcomingAppointmentsToolDescription,
                                 getWaitStatusToolDescription,
                                 getAvailableSlotsToolDescription,
                                 rescheduleAppointmentToolDescription,
                                 checkInToolDescription
                            ]
                      }
                 ],
                 voiceName: 'Aoede', // Select a voice
                 responseModalities: ["AUDIO", "TEXT"]
            });

            // 3. Connect to the WebSocket
            await this.session.connect();

            // 4. Setup Audio Input (Mic to Gemini)
            this.setupAudioInput();

            // 5. Setup Audio Output (Gemini to Speaker)
            this.setupAudioOutput();
            
            // 6. Setup event listening for incoming data from the server
            // Using the async iterator
            this.listenToSession();

            this.isSessionActive = true;
            this.micContainer.classList.add('listening');

            // 7. Initial Prompt to start conversation loop
            // Since the user is connecting, the assistant should ideally speak first based on the system prompt.
            // Sending an empty text part or a "system: user connected" string can trigger it initially.
            this.session.send({ parts: [{ text: "Hello, I am ready." }] });

        } catch (error) {
            console.error("Error starting live session:", error);
            this.assistantCaption.textContent = "Error connecting to Assistant. Please check the console.";
        }
    }

    setupAudioInput() {
        const source = this.audioContext.createMediaStreamSource(this.audioStream);
        // Using AudioWorklet is recommended for production. For simplicity in this demo, 
        // and due to Vite setup requirements for worklets, we will use a ScriptProcessor 
        // (though deprecated) to get PCM data, or simply pipe the stream if the library handles it.
        // Update: The current @google/genai library usually expects raw PCM 16-bit 16kHz audio data.
        
        // Let's create a script processor to capture and send audio 
        const bufferSize = 4096;
        const scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        // This handles downsampling if the audioContext is not 16khz natively
        source.connect(scriptNode);
        scriptNode.connect(this.audioContext.destination);

        scriptNode.onaudioprocess = (audioProcessingEvent) => {
            if (!this.isSessionActive || !this.session) return;
            
            const inputBuffer = audioProcessingEvent.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            
            // Convert Float32 to Int16
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Convert to Base64
            const buffer = new ArrayBuffer(pcmData.length * 2);
            const view = new DataView(buffer);
            pcmData.forEach((val, i) => view.setInt16(i * 2, val, true)); // little-endian
            
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Audio = btoa(binary);

            // Send RealtimeInput
            if (!this.muteIn) {
                this.session.send({
                     realtimeInput: {
                         mediaChunks: [{
                              mimeType: "audio/pcm;rate=16000",
                              data: base64Audio
                         }]
                     }
                });
            }
        };
        
        // Store node to disconnect later
        this.audioScriptNode = scriptNode;
        this.audioSourceNode = source;
    }

    setupAudioOutput() {
        // Prepare to receive PCM audio data and play it back
        this.nextPlayTime = 0;
    }

    async listenToSession() {
        try {
            for await (const message of this.session) {
                
                // Handle text responses (used for captions and UI contract)
                if (message.serverContent?.modelTurn) {
                     const parts = message.serverContent.modelTurn.parts;
                     for (const part of parts) {
                          if (part.text) {
                              this.processIncomingText(part.text);
                          }
                          
                          // Handle Audio Responses
                          if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                               this.playAudioChunk(part.inlineData.data);
                          }
                     }
                }

                if (message.serverContent?.turnComplete) {
                     this.textBuffer = ""; // Reset buffer for the next conversation turn
                }

                // Handle tool calls from the model
                if (message.toolCall) {
                     await this.handleToolCall(message.toolCall);
                }
            }
        } catch (e) {
             console.error("Session loop ended or errored:", e);
             this.handleAssistantResponse({ ui_state: 'ERROR', text: 'Connection lost or errored out.' });
             this.stopSession();
        }
    }
    
    // Play back Base64 PCM audio data received from the assistant.
    playAudioChunk(base64Data) {
         if(!this.audioContext) return;
         
         const byteCharacters = atob(base64Data);
         const byteNumbers = new Array(byteCharacters.length);
         for (let i = 0; i < byteCharacters.length; i++) {
             byteNumbers[i] = byteCharacters.charCodeAt(i);
         }
         const byteArray = new Uint8Array(byteNumbers);
         
         // Convert Int16 array back to Float32
         const pcmData = new Int16Array(byteArray.buffer);
         const float32Data = new Float32Array(pcmData.length);
         for (let i = 0; i < pcmData.length; i++) {
             float32Data[i] = pcmData[i] / 32768.0; 
         }

         const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000); // the default output rate of gemini live is often 24khz
         audioBuffer.getChannelData(0).set(float32Data);

         const source = this.audioContext.createBufferSource();
         source.buffer = audioBuffer;
         
         if (!this.gainNode) {
              this.gainNode = this.audioContext.createGain();
              this.gainNode.connect(this.audioContext.destination);
         }
         this.gainNode.gain.value = this.muteOut ? 0 : 1;
         source.connect(this.gainNode);

         // Schedule playback sequentially
         const currentTime = this.audioContext.currentTime;
         if (this.nextPlayTime < currentTime) {
              this.nextPlayTime = currentTime;
         }
         source.start(this.nextPlayTime);
         this.nextPlayTime += audioBuffer.duration;
    }


    async handleToolCall(toolCallMessage) {
         const functionCalls = toolCallMessage.functionCalls;
         const functionResponses = [];

         // Helper function to simulate network delay
         const delay = ms => new Promise(res => setTimeout(res, ms));

         for (const call of functionCalls) {
              const { name, args, id } = call;
              console.log(`Tool called: ${name}`, args);
              
              let responseContent = {};

              // --- MOCK BACKEND RESPONSES ---
              if (name === 'getUpcomingAppointments') {
                   // Mock finding user Maya
                   responseContent = {
                        appointmentId: CONFIG.appointment.id,
                        datetime: "2026-03-14T15:00:00-07:00", 
                        provider: CONFIG.appointment.provider,
                        doctorId: CONFIG.appointment.doctorId
                   };
                   
                   // Dynamic render to UI
                   const providerEl = document.querySelector('.doctor-profile h2');
                   const timeEl = document.querySelector('.doctor-profile .doc-time strong');
                   if (providerEl) providerEl.textContent = responseContent.provider;
                   if (timeEl) timeEl.textContent = this.formatTime12Hour(responseContent.datetime);

              } else if (name === 'getWaitStatus') {
                   responseContent = {
                        delayMinutes: CONFIG.delayMinutes 
                   };
              } else if (name === 'getAvailableSlots') {
                   responseContent = {
                        slots: [
                             "2026-03-14T15:45:00-07:00",
                             "2026-03-14T16:30:00-07:00"
                        ]
                   };
                   
                   // Dynamically generate UI options
                   const optionsContainer = document.getElementById('resched-options');
                   if (optionsContainer) {
                       const p = optionsContainer.querySelector('p');
                       optionsContainer.innerHTML = '';
                       if (p) optionsContainer.appendChild(p);
                       
                       responseContent.slots.forEach(slot => {
                           const btn = document.createElement('div');
                           btn.className = 'time-btn';
                           btn.textContent = this.formatTime12Hour(slot);
                           btn.addEventListener('click', (e) => {
                               const text = e.target.textContent;
                               if (this.userCaption) this.userCaption.textContent = `"${text}"`;
                               if(this.isSessionActive && this.session) {
                                  this.session.send({ parts: [{ text: text }] });
                               }
                           });
                           optionsContainer.appendChild(btn);
                       });
                   }

              } else if (name === 'rescheduleAppointment') {
                   responseContent = { status: "SUCCESS" };
                   this.finalizeDone('Rescheduled', this.formatTime12Hour(args.newDatetime));
              } else if (name === 'completeCheckIn') {
                   responseContent = { status: "SUCCESS" };
                   const originalTime = document.querySelector('.doctor-profile .doc-time strong')?.textContent || '3:00 PM';
                   this.finalizeDone('Checked In', originalTime);
              } else {
                   responseContent = { error: "Unknown function" };
              }

              functionResponses.push({
                   id: id,
                   name: name,
                   response: responseContent
              });
         }

         // Send the response back to the session
         if(this.session) {
             this.session.send({
                 toolResponse: {
                      functionResponses: functionResponses
                 }
             });
         }
    }

    processIncomingText(text) {
         this.textBuffer += text;

         // Extract only the first complete UI JSON object once available.
         const findFirstUiStateJson = (input) => {
             const key = '"ui_state"';
             const keyIndex = input.indexOf(key);
             if (keyIndex === -1) return null;

             let start = input.lastIndexOf('{', keyIndex);
             while (start !== -1) {
                 let depth = 0;
                 let inString = false;
                 let escaped = false;

                 for (let i = start; i < input.length; i++) {
                     const char = input[i];

                     if (inString) {
                         if (escaped) {
                             escaped = false;
                         } else if (char === '\\') {
                             escaped = true;
                         } else if (char === '"') {
                             inString = false;
                         }
                         continue;
                     }

                     if (char === '"') {
                         inString = true;
                     } else if (char === '{') {
                         depth++;
                     } else if (char === '}') {
                         depth--;
                         if (depth === 0) {
                             const candidate = input.slice(start, i + 1);
                             try {
                                 const parsed = JSON.parse(candidate);
                                 if (parsed && parsed.ui_state) {
                                     return {
                                         start,
                                         end: i + 1,
                                         parsed
                                     };
                                 }
                             } catch (e) {
                                 // Not valid JSON yet; continue scanning.
                             }
                         }
                     }
                 }

                 start = input.lastIndexOf('{', start - 1);
             }

             return null;
         };

         const extracted = findFirstUiStateJson(this.textBuffer);
         if (extracted) {
             this.handleAssistantResponse({
                  ui_state: extracted.parsed.ui_state,
                  tooltip: extracted.parsed.tooltip
             });

             this.textBuffer = `${this.textBuffer.slice(0, extracted.start)}${this.textBuffer.slice(extracted.end)}`;
         }

         // Clean out 'Assistant:' prefix and trim
         const cleanText = this.textBuffer.replace(/Assistant:\s*/gi, '').trim();

         if (cleanText) {
             this.assistantCaption.textContent = cleanText;
         }
    }

    async stopSession() {
        this.isSessionActive = false;
        this.micContainer.classList.remove('listening');
        
        if (this.session) {
             // Try to close nicely
             try {
                // The library might not expose an explicit close pending updates,
                // but we nullify to drop refs.
                this.session = null;
             } catch(e) {}
        }
        
        if (this.audioStream) {
             this.audioStream.getTracks().forEach(track => track.stop());
             this.audioStream = null;
        }
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
             this.audioContext.close();
             this.audioContext = null;
        }
        
        this.assistantCaption.textContent = "Session closed. Click the microphone to restart.";
    }

    /* ----------- UI Update Logic (from previous design) ------------- */

    updateUI() {
        const steps = Array.from(this.progressBar.querySelectorAll('.step'));
        const currentStateIndex = CONFIG.states.indexOf(this.currentState);
        
        steps.forEach((step, index) => {
            if (index < currentStateIndex) {
                step.classList.add('completed');
                step.classList.remove('active');
            } else if (index === currentStateIndex) {
                step.classList.add('active');
                step.classList.remove('completed');
            } else {
                step.classList.remove('active', 'completed');
            }
        });

        const viewMap = {
            'GREETING': 'view-greeting',
            'VERIFY': 'view-verify',
            'WAIT_INFO': 'view-wait',
            'RESCHED': 'view-wait',
            'DONE': 'view-done',
            'ERROR': 'view-error'
        };

        const hintCardsEl = document.querySelector('.hint-cards');
        if (hintCardsEl) {
            if (this.currentState === 'GREETING' || this.currentState === 'LISTENING') {
                 hintCardsEl.style.display = 'grid';
            } else {
                 hintCardsEl.style.display = 'none';
            }
        }

        document.querySelectorAll('.view-panel').forEach(v => v.classList.remove('active'));
        const activeViewId = viewMap[this.currentState];
        if (activeViewId) {
            document.getElementById(activeViewId).classList.add('active');
        }

        if (this.currentState === 'WAIT_INFO') {
            document.getElementById('wait-status-box').style.display = 'flex';
            document.getElementById('resched-options').style.display = 'none';
            document.getElementById('wait-status-heading').textContent = 'Checking Status';
            
            const delay = CONFIG.delayMinutes;
            document.getElementById('wait-status-value').textContent = delay > 0 ? `${delay} min delay` : 'Zero wait';
            document.getElementById('wait-status-value').style.color = delay > 0 ? 'var(--error)' : 'var(--primary-blue-dark)';

        } else if (this.currentState === 'RESCHED') {
            document.getElementById('wait-status-box').style.display = 'none';
            document.getElementById('resched-options').style.display = 'flex';
            document.getElementById('wait-status-heading').textContent = 'Reschedule';
        }
        
        if(this.currentState === 'DONE' && this.isSessionActive) {
            // Give them a moment (10 seconds), then auto-reset for kiosk mode
             setTimeout(() => {
                 this.stopSession();
                 this.currentState = 'GREETING';
                 this.updateUI();
                 this.assistantCaption.textContent = "Assistant: Hello! I'm ready for the next patient. Click the microphone to start.";
             }, 10000);
        }
    }

    async handleAssistantResponse(data) {
        const { ui_state, tooltip, text } = data;
        
        if (ui_state) {
            this.currentState = ui_state;
            this.updateUI();
        }

        if (tooltip) {
            this.showTooltip(tooltip);
        } else {
            this.hideTooltip();
        }

        if (text) {
             this.assistantCaption.textContent = text;
        }
    }

    showTooltip(text) {
        if (!this.tooltip) return;
        this.tooltip.textContent = text;
        this.tooltip.classList.remove('hidden');
        setTimeout(() => {
            this.hideTooltip();
        }, 2000);
    }

    hideTooltip() {
        if (this.tooltip) this.tooltip.classList.add('hidden');
    }

    finalizeDone(statusText, timeStr) {
        const statusEl = document.getElementById('final-status-text');
        const timeEl = document.getElementById('final-time-text');
        if (statusEl) {
            statusEl.textContent = statusText;
            if (statusText === 'Rescheduled') {
                statusEl.className = 'text-primary-blue-dark font-bold';
            }
        }
        if (timeEl) {
            timeEl.textContent = timeStr;
        }
    }
}

// Start the app
window.addEventListener('load', () => {
    new AssistantApp();
});
