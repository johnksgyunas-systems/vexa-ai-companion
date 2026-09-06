import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://rainbow-alfajores-f0f29a.netlify.app";

app.use(cors({origin(origin,callback){if(!origin||origin===allowedOrigin||origin.startsWith("http://localhost:")) return callback(null,true);return callback(new Error("Origin tidak diizinkan oleh VEXA."));}}));
app.use(express.json({limit:"1mb"}));

app.get("/",(_req,res)=>res.json({service:"VEXA AI Companion",status:"online",version:"3.1.0",voice:"shimmer"}));
app.get("/health",(_req,res)=>res.json({ok:true,service:"VEXA",version:"3.1.0",voice:"shimmer"}));

app.post("/api/chat",async(req,res)=>{
 try{
  const {message,history=[]}=req.body||{};
  if(!message||typeof message!=="string") return res.status(400).json({error:"Pesan wajib diisi."});
  const apiKey=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL;
  if(!apiKey) return res.status(500).json({error:"OPENAI_API_KEY belum diatur di server."});
  if(!model) return res.status(500).json({error:"OPENAI_MODEL belum diatur di server."});
  const client=new OpenAI({apiKey});
  const safeHistory=Array.isArray(history)?history.slice(-12).filter(i=>i&&["user","assistant"].includes(i.role)&&typeof i.content==="string"):[];
  const input=[...safeHistory.map(i=>({role:i.role,content:i.content})),{role:"user",content:message}];
  const response=await client.responses.create({model,instructions:"Kamu adalah VEXA, personal AI companion milik Bang John. Gunakan bahasa Indonesia yang natural, hangat, ringkas, tajam, dan membantu. Panggil pengguna 'Bang John'. Bantu berpikir, merencanakan, menghitung, menulis, dan mengarahkan pekerjaan bisnis. Jika permintaan menyangkut RAB, administrasi, atau sales, kamu boleh menyebut bahwa nanti tugas tersebut dapat diarahkan ke Tom, Maya, atau Karmila, tetapi jangan mengaku sudah menjalankan agent atau tindakan eksternal jika memang belum ada tool/integrasi yang melakukannya. Jangan mengarang data. Jika informasi tidak cukup, katakan dengan jelas apa yang masih dibutuhkan.",input});
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
