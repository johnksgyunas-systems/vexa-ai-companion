const VEXA_SPEECH_URL='https://vexa-ai-companion-production.up.railway.app/api/speech';
let vexaAudio=null;
speak=async function(text){
  isSpeaking=true;
  setStatus('SPEAKING');
  try{
    if(vexaAudio){vexaAudio.pause();vexaAudio=null;}
    const r=await fetch(VEXA_SPEECH_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:cleanSpeech(text)})});
    if(!r.ok)throw new Error('speech request failed');
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    vexaAudio=new Audio(url);
    await new Promise((resolve,reject)=>{vexaAudio.onended=resolve;vexaAudio.onerror=reject;vexaAudio.play().catch(reject)});
    URL.revokeObjectURL(url);
  }catch(e){
    console.error('VEXA Shimmer voice error',e);
  }finally{
    isSpeaking=false;
    vexaAudio=null;
  }
};
