Implement only the first Omarchestra feasibility spike: the visible interactive  
 Pi bridge.                                                                                         
                                                                                                    
   Read AGENTS.md, docs/design/mvp.md, and spikes/README.md completely before planning.             
                                                                                                    
   Before using Pi APIs, read the installed Pi extension documentation and every relevant linked    
 document completely:                                                                               
   - /home/woodshape/.local/share/mise/installs/pi/0.84.4/pi/docs/extensions.md                     
   - /home/woodshape/.local/share/mise/installs/pi/0.84.4/pi/docs/sdk.md                            
   - /home/woodshape/.local/share/mise/installs/pi/0.84.4/pi/docs/tui.md                            
   - relevant examples under                                                                        
 /home/woodshape/.local/share/mise/installs/pi/0.84.4/pi/examples/extensions/                       
                                                                                                    
   Question to answer:                                                                              
                                                                                                    
   Can one visible interactive Pi TUI, using an extension loaded into that same process:            
                                                                                                    
   1. handshake with a local runner stub;                                                           
   2. receive a managed assignment and execute it in the visible host session;                      
   3. emit structured lifecycle, message, tool, and attention events;                               
   4. detect a submitted human message and report manual takeover;                                  
   5. reconnect after the runner stub restarts;                                                     
   6. do all of this without launching a second hidden Pi agent?                                    
                                                                                                    
   Work only under spikes/pi-visible-bridge unless a small justfile or ignore-file change is        
 required. Do not implement Boomux, QML, SQLite, production orchestration, or the final application 
 architecture.                                                                                      
                                                                                                    
   Build the smallest throwaway extension and runner stub capable of answering the question. Add    
 focused automated tests where possible. Provide a manual interactive verification command for      
 behavior that nested/headless agents cannot truthfully validate.                                   
                                                                                                    
   The spike record must contain:                                                                   
   - question and assumptions;                                                                      
   - exact Pi version and APIs used;                                                                
   - success criteria;                                                                              
   - reproducible setup and commands;                                                               
   - captured evidence and failures;                                                                
   - supported/unsupported/supported-with-constraints conclusion;                                   
   - implications for the Pi bridge contract in docs/design/mvp.md;                                 
   - explicit disposition of every prototype file.                                                  
                                                                                                    
   Do not claim visible-TUI support without manual evidence. Stop at a clearly documented manual    
 validation gate if human observation is required.