import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://rainbow-alfajores-f0f29a.netlify.app";
const redirectUri = process.env.GOOGLE_REDIRECT_URI || "https://vexa-ai-companion-production.up.railway.app/auth/google/callback";
const timezone = "Asia/Makassar";
let googleTokens = process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN } : null;

app.use(cors({origin(origin,callback){if(!origin||origin===allowedOrigin||origin.startsWith("http://localhost:")) return callback(null,true);return callback(new Error("Origin tidak diizinkan oleh VEXA."));}}));
app.use(express.json({limit:"1mb"}));

function makeOAuthClient(){
  const clientId=process.env.GOOGLE_CLIENT_ID;
  const clientSecret=process.env.GOOGLE_CLIENT_SECRET;
  if(!clientId||!clientSecret) throw new Error("Google OAuth credentials belum lengkap.");
  return new google.auth.OAuth2(clientId,clientSecret,redirectUri);
}

function getAuthorizedGoogleClient(){
  if(!googleTokens) return null;
  const client=makeOAuthClient();
  client.setCredentials(googleTokens);
  return client;
}

function cleanJson(text){
  return String(text||"").replace(/^```json\s*/i,"").replace(/```$/i,"").trim();
}

async function planCalendarAction(client, model, message){
  const now=new Date().toISOString();
  const response=await client.responses.create({
    model,
    instructions:`Kamu adalah parser perintah Google Calendar untuk VEXA. Zona waktu pengguna adalah ${timezone} (UTC+8). Waktu saat ini ${now}. Balas HANYA JSON valid tanpa markdown. Jika pesan bukan permintaan kalender, balas {"action":"none"}. Action yang diizinkan: "list" atau "create". Untuk list, keluarkan {"action":"list","timeMin":"RFC3339","timeMax":"RFC3339","label":"deskripsi singkat rentang waktu"}. Untuk create, keluarkan {"action":"create","title":"...","start":"RFC3339","end":"RFC3339","description":"..."}. Jika durasi tidak disebut, gunakan 1 jam. Jangan mengarang nama orang atau lokasi yang tidak disebut.`,
    input:[{role:"user",content:message}]
  });
  try{return JSON.parse(cleanJson(response.output_text));}catch{return {action:"none"};}
}

async function handleCalendarCommand(openaiClient, model, message){
  const plan=await planCalendarAction(openaiClient,model,message);
  if(plan.action==="none") return null;
  const auth=getAuthorizedGoogleClient();
  if(!auth) return {handled:true,reply:"Bang John, Google Calendar belum terhubung ke VEXA. Buka pengaturan VEXA lalu hubungkan Google Calendar terlebih dahulu."};
  const calendar=google.calendar({version:"v3",auth});

  if(plan.action==="list"){
    const result=await calendar.events.list({calendarId:"primary",timeMin:plan.timeMin,timeMax:plan.timeMax,singleEvents:true,orderBy:"startTime",maxResults:20});
    const events=result.data.items||[];
    if(!events.length) return {handled:true,reply:`Bang John, tidak ada jadwal di ${plan.label||"rentang waktu itu"}.`};
    const lines=events.map((event,i)=>{
      const raw=event.start?.dateTime||event.start?.date;
      let when=raw||"waktu belum tercantum";
      if(raw&&raw.includes("T")){
        try{when=new Intl.DateTimeFormat("id-ID",{timeZone:timezone,weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(raw));}catch{}
      }
      return `${i+1}. ${event.summary||"Tanpa judul"} — ${when}`;
    });
    return {handled:true,reply:`Bang John, jadwal ${plan.label||"yang diminta"}:\n${lines.join("\n")}`};
  }

  if(plan.action==="create"){
    if(!plan.title||!plan.start||!plan.end) return {handled:true,reply:"Bang John, detail jadwalnya belum cukup. Sebutkan judul serta waktu mulai agar saya bisa memasukkannya ke Calendar."};
    const created=await calendar.events.insert({calendarId:"primary",requestBody:{summary:plan.title,start:{dateTime:plan.start,timeZone:timezone},end:{dateTime:plan.end,timeZone:timezone},description:plan.description||"Dibuat oleh VEXA"}});
    return {handled:true,reply:`Sudah, Bang John. Saya masukkan “${created.data.summary||plan.title}” ke Google Calendar.`};
  }
  return null;
}

app.get("/",(_req,res)=>res.json({service:"VEXA AI Companion",status:"online",version:"3.2.0",voice:"shimmer",calendar:Boolean(googleTokens)}));
app.get("/health",(_req,res)=>res.json({ok:true,service:"VEXA",version:"3.2.0",voice:"shimmer",calendar:Boolean(googleTokens)}));

app.get("/auth/google",(req,res)=>{
  try{
    const client=makeOAuthClient();
    const url=client.generateAuthUrl({access_type:"offline",prompt:"consent",scope:["https://www.googleapis.com/auth/calendar.events"]});
    res.redirect(url);
  }catch(error){console.error("Google auth start error:",error);res.status(500).send("Google OAuth belum siap di server VEXA.");}
});

app.get("/auth/google/callback",async(req,res)=>{
  try{
    const code=req.query.code;
    if(!code) return res.status(400).send("Kode Google tidak ditemukan.");
    const client=makeOAuthClient();
    const {tokens}=await client.getToken(code);
    googleTokens={...googleTokens,...tokens};
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VEXA Calendar</title></head><body style="font-family:system-ui;background:#06101d;color:white;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:520px;padding:24px"><h2>Google Calendar terhubung ✅</h2><p>Bang John, VEXA sekarang dapat membaca dan membuat jadwal selama server ini tetap aktif.</p><p style="opacity:.7;font-size:14px">Untuk koneksi permanen lintas redeploy, refresh token akan kita simpan aman sebagai variable Railway pada tahap berikutnya.</p><a href="${allowedOrigin}" style="color:#66c2ff">Kembali ke VEXA</a></div></body></html>`);
  }catch(error){console.error("Google auth callback error:",error);res.status(500).send("VEXA gagal menyelesaikan koneksi Google Calendar.");}
});

app.get("/api/calendar/status",(_req,res)=>res.json({ok:true,connected:Boolean(googleTokens)}));

app.post("/api/chat",async(req,res)=>{
 try{
  const {message,history=[]}=req.body||{};
  if(!message||typeof message!=="string") return res.status(400).json({error:"Pesan wajib diisi."});
  const apiKey=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL;
  if(!apiKey) return res.status(500).json({error:"OPENAI_API_KEY belum diatur di server."});
  if(!model) return res.status(500).json({error:"OPENAI_MODEL belum diatur di server."});
  const client=new OpenAI({apiKey});

  if(/kalender|calendar|jadwal|meeting|rapat|agenda/i.test(message)){
    try{
      const cal=await handleCalendarCommand(client,model,message);
      if(cal?.handled) return res.json({ok:true,reply:cal.reply,model,tool:"google_calendar"});
    }catch(error){
      console.error("VEXA calendar command error:",error);
      return res.json({ok:true,reply:"Bang John, koneksi Calendar ada, tetapi perintah jadwal tadi belum berhasil diproses. Coba ulangi dengan tanggal dan jam yang lebih jelas.",model,tool:"google_calendar"});
    }
  }

  const safeHistory=Array.isArray(history)?history.slice(-12).filter(i=>i&&["user","assistant"].includes(i.role)&&typeof i.content==="string"):[];
  const input=[...safeHistory.map(i=>({role:i.role,content:i.content})),{role:"user",content:message}];
  const response=await client.responses.create({model,instructions:"Kamu adalah VEXA, personal AI companion milik Bang John. Gunakan bahasa Indonesia yang natural, hangat, ringkas, tajam, dan membantu. Panggil pengguna 'Bang John'. Bantu berpikir, merencanakan, menghitung, menulis, dan mengarahkan pekerjaan bisnis. Jika permintaan menyangkut RAB, administrasi, atau sales, kamu boleh menyebut bahwa nanti tugas tersebut dapat diarahkan ke Tom, Maya, atau Karmila, tetapi jangan mengaku sudah menjalankan agent atau tindakan eksternal jika memang belum ada tool/integrasi yang melakukannya. VEXA kini punya integrasi Google Calendar untuk membaca dan membuat agenda setelah akun Google terhubung. Jangan mengarang data. Jika informasi tidak cukup, katakan dengan jelas apa yang masih dibutuhkan.",input});
  const text=response.output_text?.trim()||"Maaf Bang John, saya belum mendapatkan jawaban dari model.";
  res.json({ok:true,reply:text,model});
 }catch(error){console.error("VEXA chat error:",error);res.status(500).json({ok:false,error:"VEXA sedang mengalami gangguan saat menghubungi AI."});}
});

app.post("/api/speech",async(req,res)=>{
 try{
  const {text}=req.body||{};
  if(!text||typeof text!=="string") return res.status(400).json({error:"Teks wajib diisi."});
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey) return res.status(500).json({error:"OPENAI_API_KEY belum diatur di server."});
  const client=new OpenAI({apiKey});
  const speech=await client.audio.speech.create({model:"gpt-4o-mini-tts",voice:"shimmer",input:text.slice(0,4096),instructions:"Speak in natural conversational Indonesian as a warm young female personal AI companion. Sound relaxed, friendly, intelligent and human. Avoid an announcer or robotic delivery. Use natural pauses and gentle expression. The user's name Bang John should sound warm and familiar.",response_format:"mp3",speed:1.0});
  const buffer=Buffer.from(await speech.arrayBuffer());
  res.setHeader("Content-Type","audio/mpeg");
  res.setHeader("Cache-Control","no-store");
  res.send(buffer);
 }catch(error){console.error("VEXA speech error:",error);res.status(500).json({ok:false,error:"VEXA belum dapat menghasilkan suara."});}
});

app.use((err,_req,res,_next)=>{console.error("VEXA server error:",err);res.status(500).json({ok:false,error:"Terjadi kesalahan pada server VEXA."});});
app.listen(port,()=>console.log(`VEXA backend aktif di port ${port}`));
