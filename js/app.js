(function(){
  "use strict";

  /* ===== state ===== */
  var wardrobe = [];           // {id,url,color,category,name,silhouette}
  var nextId = 1;
  var CATS = [
    {key:"top",   label:"Top",        sil:"g-top"},
    {key:"bottom",label:"Bottom",     sil:"g-pant"},
    {key:"outer", label:"Outerwear",  sil:"g-coat"},
    {key:"shoe",  label:"Shoes",      sil:"g-pant"},
    {key:"acc",   label:"Accessory",  sil:"g-top"}
  ];
  function catLabel(k){ for(var i=0;i<CATS.length;i++) if(CATS[i].key===k) return CATS[i].label; return k; }
  function catSil(k){ for(var i=0;i<CATS.length;i++) if(CATS[i].key===k) return CATS[i].sil; return "g-top"; }

  /* ===== persistence (localStorage) ===== */
  var STORAGE_ITEMS = "smartwardrobe:items";
  var STORAGE_NEXTID = "smartwardrobe:nextId";
  function persistWardrobe(){
    try{
      localStorage.setItem(STORAGE_ITEMS, JSON.stringify(wardrobe));
      localStorage.setItem(STORAGE_NEXTID, String(nextId));
    }catch(e){
      // localStorage full or unavailable — wardrobe still works for this session, just won't survive reload
    }
  }
  function restoreWardrobe(){
    try{
      var raw = localStorage.getItem(STORAGE_ITEMS);
      if(!raw) return;
      var saved = JSON.parse(raw);
      if(Array.isArray(saved)) wardrobe = saved;
      var savedNextId = parseInt(localStorage.getItem(STORAGE_NEXTID), 10);
      nextId = isNaN(savedNextId) ? (wardrobe.reduce(function(m,it){ return Math.max(m, it.id||0); }, 0) + 1) : savedNextId;
    }catch(e){ wardrobe = []; }
  }

  /* ===== elements ===== */
  var fileInput = document.getElementById("fileInput");
  var dropzone  = document.getElementById("dropzone");
  var itemGrid  = document.getElementById("itemGrid");
  var emptyNote = document.getElementById("emptyNote");
  var itemCount = document.getElementById("itemCount");
  var heroCount = document.getElementById("heroCount");
  var clearBtn  = document.getElementById("clearBtn");
  var rail      = document.getElementById("rail");

  /* ===== background removal + garment-focused color extraction ===== */
  function colorDist(r1,g1,b1,r2,g2,b2){
    var dr=r1-r2, dg=g1-g2, db=b1-b2;
    return Math.sqrt(dr*dr+dg*dg+db*db);
  }

  // Heuristic chroma-key cutout: flood-fills the background starting from the
  // image border (typical garment photos have a roughly uniform backdrop) and
  // keeps everything else opaque. Returns null when the photo doesn't look
  // like a clean foreground/background split, so the caller can fall back.
  function removeBackground(srcCanvas){
    var w = srcCanvas.width, h = srcCanvas.height;
    var imgData = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
    var data = imgData.data;
    var tolerance = 32;
    function idx(x,y){ return (y*w+x)*4; }

    var borderPts = [];
    var step = Math.max(1, Math.round(Math.min(w,h)/40));
    for(var x=0; x<w; x+=step){ borderPts.push(x,0,x,h-1); }
    for(var y=0; y<h; y+=step){ borderPts.push(0,y,w-1,y); }

    var br=0,bg=0,bb=0,bn=0;
    for(var p=0;p<borderPts.length;p+=2){
      var bi0 = idx(borderPts[p], borderPts[p+1]);
      br+=data[bi0]; bg+=data[bi0+1]; bb+=data[bi0+2]; bn++;
    }
    br/=bn; bg/=bn; bb/=bn;

    var visited = new Uint8Array(w*h);
    var bgMask  = new Uint8Array(w*h);
    var queue = [];
    for(var p2=0;p2<borderPts.length;p2+=2){
      var bx=borderPts[p2], by=borderPts[p2+1];
      var pos0 = by*w+bx;
      if(visited[pos0]) continue;
      visited[pos0] = 1;
      var di0 = idx(bx,by);
      if(colorDist(data[di0],data[di0+1],data[di0+2], br,bg,bb) <= tolerance){
        bgMask[pos0] = 1; queue.push(pos0);
      }
    }

    var dxs=[-1,1,0,0], dys=[0,0,-1,1], qi = 0;
    while(qi < queue.length){
      var pos = queue[qi++];
      var px = pos % w, py = (pos - px) / w;
      for(var n=0;n<4;n++){
        var nx=px+dxs[n], ny=py+dys[n];
        if(nx<0||ny<0||nx>=w||ny>=h) continue;
        var ni = ny*w+nx;
        if(visited[ni]) continue;
        visited[ni] = 1;
        var ndi = idx(nx,ny);
        if(colorDist(data[ndi],data[ndi+1],data[ndi+2], br,bg,bb) <= tolerance){
          bgMask[ni] = 1; queue.push(ni);
        }
      }
    }

    var fgCount = 0;
    for(var k=0;k<w*h;k++){ if(!bgMask[k]) fgCount++; }
    var coverage = fgCount / (w*h);
    if(coverage < 0.02 || coverage > 0.98) return null; // no clean foreground/background split

    var rawAlpha = new Uint8ClampedArray(w*h);
    for(var m=0;m<w*h;m++){ rawAlpha[m] = bgMask[m] ? 0 : 255; }

    var minX=w, minY=h, maxX=0, maxY=0;
    for(var yy=0; yy<h; yy++){
      for(var xx=0; xx<w; xx++){
        var sum=0, cnt=0;
        for(var oy=-1;oy<=1;oy++){
          for(var ox=-1;ox<=1;ox++){
            var sx=xx+ox, sy=yy+oy;
            if(sx<0||sy<0||sx>=w||sy>=h) continue;
            sum += rawAlpha[sy*w+sx]; cnt++;
          }
        }
        var a = Math.round(sum/cnt);
        data[idx(xx,yy)+3] = a;
        if(a>8){ if(xx<minX)minX=xx; if(xx>maxX)maxX=xx; if(yy<minY)minY=yy; if(yy>maxY)maxY=yy; }
      }
    }
    if(maxX<minX || maxY<minY) return null;

    // write the alpha-adjusted pixels to a fresh canvas so the original
    // (opaque) source canvas stays usable for a JPEG fallback if needed
    var tmp = document.createElement("canvas"); tmp.width=w; tmp.height=h;
    tmp.getContext("2d").putImageData(imgData, 0, 0);

    var pad = 6;
    var cropX = Math.max(0, minX-pad), cropY = Math.max(0, minY-pad);
    var cropW = Math.min(w, maxX+pad+1) - cropX;
    var cropH = Math.min(h, maxY+pad+1) - cropY;

    var out = document.createElement("canvas"); out.width=cropW; out.height=cropH;
    out.getContext("2d").drawImage(tmp, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    var sample = out.getContext("2d").getImageData(0, 0, cropW, cropH).data;
    var r=0,g=0,b=0,n=0;
    for(var s=0; s<sample.length; s+=4){
      if(sample[s+3] > 80){ r+=sample[s]; g+=sample[s+1]; b+=sample[s+2]; n++; }
    }
    if(!n) return null;

    return {
      dataUrl: out.toDataURL("image/png"),
      color: "rgb("+Math.round(r/n)+","+Math.round(g/n)+","+Math.round(b/n)+")"
    };
  }

  function avgColorFallback(canvas){
    var sw=12, sh=12, sc=document.createElement("canvas"); sc.width=sw; sc.height=sh;
    sc.getContext("2d").drawImage(canvas, 0, 0, sw, sh);
    var d = sc.getContext("2d").getImageData(0,0,sw,sh).data, r=0,g=0,b=0,n=0;
    for(var i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
    return "rgb("+Math.round(r/n)+","+Math.round(g/n)+","+Math.round(b/n)+")";
  }

  /* ===== downscale, attempt a background cutout, fall back to a flat photo ===== */
  function processGarmentImage(img, cb){
    try{
      var maxDim = 640;
      var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);

      var cutout = removeBackground(c);
      if(cutout){ cb(cutout.dataUrl, cutout.color, true); return; }

      cb(c.toDataURL("image/jpeg", 0.85), avgColorFallback(c), false);
    }catch(e){ cb(null, "#C9C6D2", false); }
  }

  /* ===== add uploaded files ===== */
  function addFiles(files){
    var arr = Array.prototype.slice.call(files).filter(function(f){ return /^image\//.test(f.type); });
    arr.forEach(function(file){
      var reader = new FileReader();
      reader.onload = function(){
        var img = new Image();
        img.onload = function(){
          processGarmentImage(img, function(dataUrl, color, cutout){
            var item = { id: nextId++, url: dataUrl, color: color, category: "top", name: "Wardrobe piece", silhouette: "g-top", cutout: !!cutout };
            wardrobe.push(item);
            renderItems(); renderRail(); updateCounts(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
          });
        };
        img.onerror = function(){
          var item = {id:nextId++, url:null, color:"#C9C6D2", category:"top", name:"Wardrobe piece", silhouette:"g-top", cutout:false};
          wardrobe.push(item); renderItems(); renderRail(); updateCounts(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ===== sample wardrobe (no photos needed) ===== */
  function loadSample(){
    var sample = [
      {category:"top",   color:"#F5F4F1", name:"White Oxford shirt"},
      {category:"top",   color:"#26334F", name:"Navy merino knit"},
      {category:"top",   color:"#7C2B3B", name:"Burgundy polo"},
      {category:"bottom",color:"#2B3550", name:"Dark indigo jeans"},
      {category:"bottom",color:"#C2B49A", name:"Stone chinos"},
      {category:"bottom",color:"#3A3A40", name:"Charcoal trousers"},
      {category:"shoe",  color:"#ECECEC", name:"White sneakers"},
      {category:"shoe",  color:"#6E4326", name:"Brown leather boots"},
      {category:"outer", color:"#B58A57", name:"Camel overcoat"},
      {category:"outer", color:"#222E47", name:"Navy blazer"},
      {category:"acc",   color:"#9A6B43", name:"Tan leather belt"},
      {category:"acc",   color:"#BFC2C7", name:"Silver watch"}
    ];
    sample.forEach(function(s){
      wardrobe.push({id:nextId++, url:null, color:s.color, category:s.category, name:s.name, silhouette:catSil(s.category)});
    });
    renderItems(); renderRail(); updateCounts(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
  }

  /* ===== render item grid ===== */
  function renderItems(){
    itemGrid.innerHTML = "";
    wardrobe.forEach(function(it){
      var card = document.createElement("div");
      card.className = "item";
      var ph = document.createElement("div");
      ph.className = "ph";
      if(it.url){
        var phImg = document.createElement("div");
        phImg.className = "ph-img";
        phImg.style.backgroundImage = "url('"+it.url+"')";
        phImg.style.backgroundSize = it.cutout ? "contain" : "cover";
        if(it.cutout) ph.classList.add("cutout-bg");
        ph.appendChild(phImg);
      } else {
        ph.style.background = it.color;
      }
      var rm = document.createElement("button");
      rm.className = "rm"; rm.type="button"; rm.setAttribute("aria-label","Remove item"); rm.textContent="×";
      rm.addEventListener("click", function(){
        wardrobe = wardrobe.filter(function(x){ return x.id!==it.id; });
        renderItems(); renderRail(); updateCounts(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
      });
      ph.appendChild(rm);
      var meta = document.createElement("div");
      meta.className = "meta";
      var sel = document.createElement("select");
      sel.setAttribute("aria-label","Category");
      CATS.forEach(function(c){
        var o = document.createElement("option");
        o.value=c.key; o.textContent=c.label;
        if(c.key===it.category) o.selected=true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function(){
        it.category = sel.value; it.silhouette = catSil(sel.value);
        renderRail(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
      });
      meta.appendChild(sel);
      var measRow = document.createElement("div");
      measRow.className = "meas-row";
      var wIn = document.createElement("input");
      wIn.type="number"; wIn.min="0"; wIn.placeholder="Width cm"; wIn.setAttribute("aria-label","Garment width in cm"); wIn.value = it.measureW || "";
      var lIn = document.createElement("input");
      lIn.type="number"; lIn.min="0"; lIn.placeholder="Length cm"; lIn.setAttribute("aria-label","Garment length in cm"); lIn.value = it.measureL || "";
      wIn.addEventListener("change", function(){ it.measureW = wIn.value; persistWardrobe(); });
      lIn.addEventListener("change", function(){ it.measureL = lIn.value; persistWardrobe(); });
      measRow.appendChild(wIn); measRow.appendChild(lIn);
      meta.appendChild(measRow);
      card.appendChild(ph); card.appendChild(meta);
      itemGrid.appendChild(card);
    });
    emptyNote.style.display = wardrobe.length ? "none" : "block";
    clearBtn.hidden = wardrobe.length === 0;
  }

  /* ===== render rail (hero) ===== */
  function renderRail(){
    rail.innerHTML = "";
    var show = wardrobe.slice(0,9);
    if(show.length === 0){
      // decorative placeholder rail
      var demo = [
        {c:"#23222B",t:"g-top",h:120},{c:"#6E6A78",t:"g-pant",h:150},
        {c:"#7C2B3B",t:"g-top",h:128},{c:"#B58A57",t:"g-coat",h:165},
        {c:"#C9A24B",t:"g-top",h:118},{c:"#4F7C58",t:"g-pant",h:150},
        {c:"#3E7A98",t:"g-coat",h:165},{c:"#4034A8",t:"g-top",h:126},
        {c:"#C9C6D2",t:"g-pant",h:148}
      ];
      demo.forEach(function(g){ railGarment(g.c,null,g.t,g.h); });
      return;
    }
    var heights=[120,150,128,165,118,150,165,126,148];
    show.forEach(function(it,i){
      railGarment(it.color, it.url, it.silhouette, heights[i%heights.length]);
    });
  }
  function railGarment(color,url,sil,h){
    var d=document.createElement("div"); d.className="garment "+sil; d.style.setProperty("--h",h+"px");
    var b=document.createElement("div"); b.className="g-body";
    if(url){ b.style.backgroundImage="url('"+url+"')"; } else { b.style.setProperty("--g",color); }
    d.appendChild(b); rail.appendChild(d);
  }

  function updateCounts(){
    itemCount.textContent = wardrobe.length;
    heroCount.textContent = wardrobe.length + (wardrobe.length===1?" item":" items");
  }

  /* ===== wiring: upload ===== */
  document.getElementById("browseBtn").addEventListener("click", function(e){ e.stopPropagation(); fileInput.click(); });
  document.getElementById("sampleBtn").addEventListener("click", function(e){ e.stopPropagation(); loadSample(); });
  dropzone.addEventListener("click", function(){ fileInput.click(); });
  dropzone.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fileInput.click(); }});
  fileInput.addEventListener("change", function(){ addFiles(fileInput.files); fileInput.value=""; });
  ["dragenter","dragover"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.add("drag"); }); });
  ["dragleave","drop"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.remove("drag"); }); });
  dropzone.addEventListener("drop", function(e){ if(e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  clearBtn.addEventListener("click", function(){
    wardrobe = []; renderItems(); renderRail(); updateCounts(); refreshGenAvailability(); refreshTryonAvailability(); persistWardrobe();
  });

  /* ===== shared outfit builder ===== */
  function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function byCat(cat){ return wardrobe.filter(function(x){ return x.category===cat; }); }
  function hasEnough(){ return wardrobe.length >= 2; }

  function buildOutfit(needOuter){
    var roles = [
      {cat:"top",   role:"Top"},
      {cat:"bottom",role:"Bottom"},
      {cat:"shoe",  role:"Shoes"},
      {cat:needOuter?"outer":"acc", role:needOuter?"Outerwear":"Accessory"}
    ];
    var out = [];
    roles.forEach(function(r){
      var pool = byCat(r.cat);
      if(pool.length) out.push({item:pick(pool), role:r.role});
    });
    // if too few matched (e.g. all items same category), just pick any distinct items
    if(out.length < 2){
      var shuffled = wardrobe.slice().sort(function(){ return Math.random()-0.5; }).slice(0,4);
      out = shuffled.map(function(it){ return {item:it, role:catLabel(it.category)}; });
    }
    return out;
  }
  function pieceSwatchStyle(it){
    return it.url ? "background-image:url('"+it.url+"')" : "background:"+it.color;
  }

  /* ===== hero generate ===== */
  var heroPieces=document.getElementById("heroPieces"), heroOutfit=document.getElementById("heroOutfit"), heroOcc=document.getElementById("heroOcc");
  document.getElementById("heroGenerate").addEventListener("click", function(){
    if(!hasEnough()){ loadSample(); }
    var combo = buildOutfit(Math.random()<0.4);
    heroPieces.innerHTML = combo.map(function(x){
      return '<div class="piece"><div class="swatch" style="'+pieceSwatchStyle(x.item)+'"></div>'+
             '<div class="nm">'+x.item.name+'</div><div class="ty">'+x.role+'</div></div>';
    }).join("");
    heroOcc.textContent = "For " + pick(["work","a walk","dinner","the weekend","a meeting"]);
    heroOutfit.classList.add("show");
  });

  /* ===== generator section ===== */
  var OCCASIONS=["Work","Walk","Date","Restaurant","Meeting","Travel","Party","Hot weather","Rain","Cold weather"];
  var WHY={Work:"Polished and comfortable for a full day.",Walk:"Easy layers you can move in.",Date:"A confident, considered look.",Restaurant:"Smart-casual, dressed up a notch.",Meeting:"Sharp and professional.",Travel:"Comfortable for hours in transit.",Party:"A standout combination from your closet.","Hot weather":"Light pieces that breathe.",Rain:"Water-ready, still put together.","Cold weather":"Warm layers that work together."};
  var activeOcc="Work";
  var occWrap=document.getElementById("occasions");
  OCCASIONS.forEach(function(o,i){
    var b=document.createElement("button"); b.className="occ"+(i===0?" active":""); b.textContent=o;
    b.addEventListener("click", function(){
      occWrap.querySelectorAll(".occ").forEach(function(x){ x.classList.remove("active"); });
      b.classList.add("active"); activeOcc=o;
    });
    occWrap.appendChild(b);
  });

  var genGrid=document.getElementById("genGrid"), genEmpty=document.getElementById("genEmpty"),
      genEmptyMsg=document.getElementById("genEmptyMsg"), genAgain=document.getElementById("genAgain"),
      genWhy=document.getElementById("genWhy"), genBtn=document.getElementById("genBtn");

  function refreshGenAvailability(){
    genEmptyMsg.textContent = hasEnough()
      ? "Tap Create an outfit to build a look from your wardrobe."
      : "Add a few clothes above, then create your look.";
  }

  function genBuild(){
    if(!hasEnough()){ loadSample(); }
    var needOuter = ["Cold weather","Rain","Meeting","Restaurant"].indexOf(activeOcc) > -1;
    var combo = buildOutfit(needOuter);
    genGrid.innerHTML = combo.map(function(x){
      return '<div class="gp"><div class="gsw" style="'+pieceSwatchStyle(x.item)+'"></div>'+
             '<div class="nm">'+x.item.name+'</div><div class="role">'+x.role+'</div></div>';
    }).join("");
    genEmpty.style.display="none"; genGrid.style.display="grid";
    genAgain.style.display="inline-flex"; genWhy.textContent = WHY[activeOcc]||"";
  }
  genBtn.addEventListener("click", genBuild);
  genAgain.addEventListener("click", genBuild);

  /* ===== match around one item (static demo) ===== */
  var ANCHORS=[
    {nm:"White Oxford shirt",c:"#F5F4F1",pairs:[{nm:"Dark indigo jeans",c:"#2B3550",r:"Bottom"},{nm:"Camel overcoat",c:"#B58A57",r:"Outerwear"},{nm:"Brown leather boots",c:"#6E4326",r:"Shoes"},{nm:"Tan leather belt",c:"#9A6B43",r:"Belt"},{nm:"Silver watch",c:"#BFC2C7",r:"Watch"},{nm:"Navy blazer",c:"#222E47",r:"Layer"}]},
    {nm:"Dark indigo jeans",c:"#2B3550",pairs:[{nm:"White Oxford shirt",c:"#F5F4F1",r:"Top"},{nm:"Navy merino knit",c:"#26334F",r:"Layer"},{nm:"White sneakers",c:"#ECECEC",r:"Shoes"},{nm:"Denim jacket",c:"#3E5A78",r:"Outerwear"},{nm:"Tan leather belt",c:"#9A6B43",r:"Belt"},{nm:"Suede loafers",c:"#8A6B4A",r:"Shoes"}]},
    {nm:"Camel overcoat",c:"#B58A57",pairs:[{nm:"Navy merino knit",c:"#26334F",r:"Top"},{nm:"Charcoal trousers",c:"#3A3A40",r:"Bottom"},{nm:"Black derbies",c:"#1E1E22",r:"Shoes"},{nm:"Wool scarf",c:"#8C3A4A",r:"Accessory"},{nm:"Leather tote",c:"#5A3C2A",r:"Bag"},{nm:"Silver watch",c:"#BFC2C7",r:"Watch"}]},
    {nm:"White sneakers",c:"#ECECEC",pairs:[{nm:"Stone chinos",c:"#C2B49A",r:"Bottom"},{nm:"Striped tee",c:"#C9C6D2",r:"Top"},{nm:"Denim jacket",c:"#3E5A78",r:"Outerwear"},{nm:"Dark indigo jeans",c:"#2B3550",r:"Bottom"},{nm:"Olive overshirt",c:"#6B6B43",r:"Layer"},{nm:"Silver watch",c:"#BFC2C7",r:"Watch"}]}
  ];
  var pickWrap=document.getElementById("pick"), matchTitle=document.getElementById("matchTitle"), pairList=document.getElementById("pairList");
  function renderMatch(idx){
    var a=ANCHORS[idx]; matchTitle.textContent=a.nm;
    pairList.innerHTML=a.pairs.map(function(p){ return '<div class="pair"><div class="sw" style="background:'+p.c+'"></div><div class="nm">'+p.nm+'</div><div class="ro">'+p.r+'</div></div>'; }).join("");
    pickWrap.querySelectorAll("button").forEach(function(b,i){ b.classList.toggle("active", i===idx); });
  }
  ANCHORS.forEach(function(a,i){
    var b=document.createElement("button"); b.innerHTML='<span class="sw" style="background:'+a.c+'"></span>'+a.nm;
    if(i===0) b.classList.add("active");
    b.addEventListener("click", function(){ renderMatch(i); });
    pickWrap.appendChild(b);
  });
  renderMatch(0);

  /* ===== assistant ===== */
  var PROMPTS=[
    {q:"Dress me for today.",a:"Done. For a mild day: navy merino knit, stone chinos, white sneakers, and your silver watch. Easy and clean."},
    {q:"I need an outfit to meet a client.",a:"Sharp choice: navy blazer over a white Oxford shirt, charcoal trousers, and black derbies. Professional and confident."},
    {q:"It's 54°F and raining today.",a:"Stay dry: charcoal trench, navy knit, dark indigo jeans, and your waterproof boots."},
    {q:"Pack me for three days.",a:"Packed: 3 tops, 2 bottoms, 1 overcoat, 2 pairs of shoes — mixing into 6 full outfits from your closet."}
  ];
  var chat=document.getElementById("chat"), promptsWrap=document.getElementById("prompts");
  PROMPTS.forEach(function(p){
    var b=document.createElement("button"); b.className="prompt"; b.innerHTML="<span>"+p.q+"</span>";
    b.addEventListener("click", function(){
      chat.innerHTML='<div class="chat-row"><div class="bubble from-user">'+p.q+'</div></div><div class="chat-row"><div class="bubble from-ai">'+p.a+'</div></div>';
    });
    promptsWrap.appendChild(b);
  });

  /* ===== signup + verification ===== */
  var tabEmail=document.getElementById("tabEmail"), tabPhone=document.getElementById("tabPhone"),
      inLabel=document.getElementById("inLabel"), input=document.getElementById("signupInput"),
      err=document.getElementById("signupErr"), mode="email";
  function setMode(m){
    mode=m; tabEmail.classList.toggle("active",m==="email"); tabPhone.classList.toggle("active",m==="phone");
    if(m==="email"){ inLabel.textContent="Email address"; input.type="email"; input.placeholder="you@example.com"; input.autocomplete="email"; err.textContent="Enter a valid email address."; }
    else { inLabel.textContent="Phone number"; input.type="tel"; input.placeholder="+1 555 000 1234"; input.autocomplete="tel"; err.textContent="Enter a valid phone number."; }
    input.value=""; err.classList.remove("show");
  }
  tabEmail.addEventListener("click", function(){ setMode("email"); });
  tabPhone.addEventListener("click", function(){ setMode("phone"); });

  var stepDetails=document.getElementById("stepDetails"), stepVerify=document.getElementById("stepVerify"),
      stepDone=document.getElementById("stepDone"), dest=document.getElementById("dest"),
      codeInputs=Array.prototype.slice.call(document.querySelectorAll("#codeBoxes input"));
  function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function validPhone(v){ return /^[+]?[\d\s().-]{7,}$/.test(v); }

  document.getElementById("createBtn").addEventListener("click", function(){
    var v=input.value.trim(); var ok = mode==="email" ? validEmail(v) : validPhone(v);
    if(!ok){ err.classList.add("show"); input.focus(); return; }
    err.classList.remove("show"); dest.textContent=v;
    stepDetails.style.display="none"; stepVerify.classList.add("show");
    setTimeout(function(){ codeInputs[0].focus(); }, 60);
  });
  document.getElementById("backBtn").addEventListener("click", function(){
    stepVerify.classList.remove("show"); stepDetails.style.display="block";
    codeInputs.forEach(function(i){ i.value=""; });
  });
  document.getElementById("resendBtn").addEventListener("click", function(){
    codeInputs.forEach(function(i){ i.value=""; }); codeInputs[0].focus();
  });
  function checkCode(){
    if(codeInputs.every(function(i){ return i.value.length===1; })){
      stepVerify.classList.remove("show"); stepDone.classList.add("show");
    }
  }
  codeInputs.forEach(function(inp,i){
    inp.addEventListener("input", function(){
      inp.value=inp.value.replace(/\D/g,"").slice(0,1);
      if(inp.value && i<codeInputs.length-1) codeInputs[i+1].focus();
      checkCode();
    });
    inp.addEventListener("keydown", function(e){ if(e.key==="Backspace" && !inp.value && i>0) codeInputs[i-1].focus(); });
    inp.addEventListener("paste", function(e){
      e.preventDefault();
      var ds=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,6).split("");
      ds.forEach(function(d,k){ if(codeInputs[k]) codeInputs[k].value=d; });
      (codeInputs[ds.length]||codeInputs[5]).focus(); checkCode();
    });
  });
  document.getElementById("restartBtn").addEventListener("click", function(){
    stepDone.classList.remove("show"); codeInputs.forEach(function(i){ i.value=""; });
    setMode("email"); stepDetails.style.display="block";
  });

  /* ===== weather ===== */
  var WMO = {
    0:{label:"Clear sky",emoji:"☀️",group:"clear"},     1:{label:"Mainly clear",emoji:"🌤️",group:"clear"},
    2:{label:"Partly cloudy",emoji:"⛅",group:"cloudy"}, 3:{label:"Overcast",emoji:"☁️",group:"cloudy"},
    45:{label:"Fog",emoji:"🌫️",group:"fog"},            48:{label:"Freezing fog",emoji:"🌫️",group:"fog"},
    51:{label:"Light drizzle",emoji:"🌦️",group:"rain"}, 53:{label:"Drizzle",emoji:"🌦️",group:"rain"},
    55:{label:"Dense drizzle",emoji:"🌦️",group:"rain"}, 56:{label:"Freezing drizzle",emoji:"🌧️",group:"rain"},
    57:{label:"Freezing drizzle",emoji:"🌧️",group:"rain"}, 61:{label:"Light rain",emoji:"🌧️",group:"rain"},
    63:{label:"Rain",emoji:"🌧️",group:"rain"},          65:{label:"Heavy rain",emoji:"🌧️",group:"rain"},
    66:{label:"Freezing rain",emoji:"🌧️",group:"rain"}, 67:{label:"Freezing rain",emoji:"🌧️",group:"rain"},
    71:{label:"Light snow",emoji:"🌨️",group:"snow"},    73:{label:"Snow",emoji:"🌨️",group:"snow"},
    75:{label:"Heavy snow",emoji:"❄️",group:"snow"},     77:{label:"Snow grains",emoji:"🌨️",group:"snow"},
    80:{label:"Rain showers",emoji:"🌦️",group:"rain"},  81:{label:"Rain showers",emoji:"🌦️",group:"rain"},
    82:{label:"Violent showers",emoji:"⛈️",group:"rain"}, 85:{label:"Snow showers",emoji:"🌨️",group:"snow"},
    86:{label:"Snow showers",emoji:"🌨️",group:"snow"},  95:{label:"Thunderstorm",emoji:"⛈️",group:"storm"},
    96:{label:"Thunderstorm + hail",emoji:"⛈️",group:"storm"}, 99:{label:"Thunderstorm + hail",emoji:"⛈️",group:"storm"}
  };
  function wmoInfo(code){ return WMO[code] || {label:"Unknown",emoji:"🌡️",group:"clear"}; }
  function tempBand(t){
    if(t>=24) return "hot";
    if(t>=17) return "warm";
    if(t>=10) return "mild";
    if(t>=4)  return "cool";
    return "cold";
  }

  var wlocLabel=document.getElementById("wlocLabel"), weatherStatus=document.getElementById("weatherStatus"),
      weatherNow=document.getElementById("weatherNow"), wTemp=document.getElementById("wTemp"),
      wCond=document.getElementById("wCond"), wExtra=document.getElementById("wExtra"),
      weatherOutfit=document.getElementById("weatherOutfit"), weatherPieces=document.getElementById("weatherPieces"),
      weatherChip=document.getElementById("weatherChip"), wUseGps=document.getElementById("wUseGps"),
      wCityForm=document.getElementById("wCityForm"), wCityInput=document.getElementById("wCityInput"),
      wCitySuggest=document.getElementById("wCitySuggest");

  var STORAGE_LOC = "smartwardrobe:loc";
  function saveLoc(loc){ try{ localStorage.setItem(STORAGE_LOC, JSON.stringify(loc)); }catch(e){} }
  function loadSavedLoc(){ try{ var s=localStorage.getItem(STORAGE_LOC); return s?JSON.parse(s):null; }catch(e){ return null; } }
  function setWeatherStatus(t){ weatherStatus.textContent = t; }

  function applyWeather(data, label){
    var cur = data.current;
    var info = wmoInfo(cur.weather_code);
    wTemp.textContent = Math.round(cur.temperature_2m);
    wCond.textContent = info.emoji + " " + info.label;
    var bits = [];
    if(typeof cur.precipitation==="number" && cur.precipitation>0) bits.push(cur.precipitation.toFixed(1)+" mm precip");
    if(typeof cur.wind_speed_10m==="number") bits.push(Math.round(cur.wind_speed_10m)+" km/h wind");
    wExtra.textContent = bits.join(" · ");
    weatherNow.hidden = false;
    wlocLabel.textContent = label;
    setWeatherStatus("");

    var band = tempBand(cur.temperature_2m);
    var rainy = info.group==="rain" || info.group==="storm" || info.group==="snow";
    var needOuter = band==="cold" || band==="cool" || rainy;
    if(!hasEnough()) loadSample();
    var combo = buildOutfit(needOuter);
    weatherPieces.innerHTML = combo.map(function(x){
      return '<div class="piece"><div class="swatch" style="'+pieceSwatchStyle(x.item)+'"></div>'+
             '<div class="nm">'+x.item.name+'</div><div class="ty">'+x.role+'</div></div>';
    }).join("");
    var chipText = band==="hot"?"Hot day":band==="warm"?"Warm day":band==="mild"?"Mild day":band==="cool"?"Cool day":"Cold day";
    if(rainy) chipText += " · " + info.label;
    weatherChip.textContent = chipText;
    weatherOutfit.classList.add("show");
  }

  function fetchWeather(lat, lon, label, locMeta){
    setWeatherStatus("Loading weather…");
    wlocLabel.textContent = label;
    fetch("https://api.open-meteo.com/v1/forecast?latitude="+lat+"&longitude="+lon+"&current=temperature_2m,precipitation,weather_code,wind_speed_10m")
      .then(function(r){ if(!r.ok) throw new Error("weather request failed"); return r.json(); })
      .then(function(data){ applyWeather(data, label); if(locMeta) saveLoc(locMeta); })
      .catch(function(){ setWeatherStatus("Couldn't load the weather right now. Try a city search instead."); });
  }

  function reverseGeocodeLabel(lat, lon, fallback){
    fetch("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude="+lat+"&longitude="+lon+"&localityLanguage=en")
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        var name = d && (d.city || d.locality);
        wlocLabel.textContent = name ? name + (d.countryName ? ", "+d.countryName : "") : fallback;
      })
      .catch(function(){});
  }

  function useGps(){
    if(!navigator.geolocation){ setWeatherStatus("Your browser doesn't support location detection — search a city instead."); return; }
    setWeatherStatus("Detecting your location…");
    navigator.geolocation.getCurrentPosition(function(pos){
      var lat=pos.coords.latitude, lon=pos.coords.longitude;
      fetchWeather(lat, lon, "Your current location", {mode:"gps"});
      reverseGeocodeLabel(lat, lon, "Your current location");
    }, function(){
      setWeatherStatus("Location access denied — search a city instead.");
    }, {timeout:10000});
  }

  function searchCity(query){
    setWeatherStatus("Searching…");
    wCitySuggest.hidden = true; wCitySuggest.innerHTML = "";
    fetch("https://geocoding-api.open-meteo.com/v1/search?name="+encodeURIComponent(query)+"&count=5&language=en&format=json")
      .then(function(r){ return r.json(); })
      .then(function(d){
        var results = (d && d.results) || [];
        if(!results.length){ setWeatherStatus("No matching city found."); return; }
        setWeatherStatus("");
        wCitySuggest.hidden = false;
        results.forEach(function(res){
          var label = res.name + (res.admin1?", "+res.admin1:"") + (res.country?", "+res.country:"");
          var b=document.createElement("button"); b.type="button"; b.textContent=label;
          b.addEventListener("click", function(){
            wCitySuggest.hidden = true;
            fetchWeather(res.latitude, res.longitude, label, {mode:"manual", label:label, lat:res.latitude, lon:res.longitude});
          });
          wCitySuggest.appendChild(b);
        });
      })
      .catch(function(){ setWeatherStatus("Couldn't search right now — try again in a moment."); });
  }

  wUseGps.addEventListener("click", useGps);
  wCityForm.addEventListener("submit", function(e){
    e.preventDefault();
    var v = wCityInput.value.trim();
    if(v) searchCity(v);
  });

  function initWeather(){
    var saved = loadSavedLoc();
    if(saved && saved.mode==="manual" && saved.lat!=null){
      fetchWeather(saved.lat, saved.lon, saved.label, saved);
    } else {
      useGps();
    }
  }

  /* ===== avatar / try-on ===== */
  var STORAGE_AVATAR = "smartwardrobe:avatar";
  var avatarState = {
    height: 175, build: "regular", face: null, zoom: "far", bg: "studio",
    picks: { top: null, outer: null, bottom: null, shoe: null },
    measurements: { height: "", chest: "", waist: "", hips: "" }
  };

  function mergeAvatar(saved){
    if(!saved || typeof saved !== "object") return;
    if(typeof saved.height === "number") avatarState.height = saved.height;
    if(typeof saved.build === "string") avatarState.build = saved.build;
    if(typeof saved.face === "string" || saved.face === null) avatarState.face = saved.face;
    if(typeof saved.zoom === "string") avatarState.zoom = saved.zoom;
    if(typeof saved.bg === "string") avatarState.bg = saved.bg;
    if(saved.picks){
      ["top","outer","bottom","shoe"].forEach(function(k){
        if(saved.picks[k]!==undefined) avatarState.picks[k] = saved.picks[k];
      });
    }
    if(saved.measurements){
      ["height","chest","waist","hips"].forEach(function(k){
        if(saved.measurements[k]!==undefined) avatarState.measurements[k] = saved.measurements[k];
      });
    }
  }
  function saveAvatar(){
    try{ localStorage.setItem(STORAGE_AVATAR, JSON.stringify(avatarState)); }catch(e){}
  }
  function loadAvatar(){
    try{
      var raw = localStorage.getItem(STORAGE_AVATAR);
      if(raw) mergeAvatar(JSON.parse(raw));
    }catch(e){}
  }

  var avHeight=document.getElementById("avHeight"), avHeightVal=document.getElementById("avHeightVal"),
      avBuildSeg=document.getElementById("avBuildSeg"),
      avFaceBtn=document.getElementById("avFaceBtn"), avFaceClear=document.getElementById("avFaceClear"), avFaceInput=document.getElementById("avFaceInput"),
      tryonPicks=document.getElementById("tryonPicks"), bgSwatches=document.getElementById("bgSwatches"),
      tryonStage=document.getElementById("tryonStage"), zoomClose=document.getElementById("zoomClose"), zoomFar=document.getElementById("zoomFar"),
      figure=document.getElementById("figure"), figHead=document.getElementById("figHead"),
      figTorso=document.getElementById("figTorso"), figOuter=document.getElementById("figOuter"), figLegs=document.getElementById("figLegs"),
      figShoeL=document.getElementById("figShoeL"), figShoeR=document.getElementById("figShoeR"), tryonEmpty=document.getElementById("tryonEmpty"),
      mHeight=document.getElementById("mHeight"), mChest=document.getElementById("mChest"), mWaist=document.getElementById("mWaist"), mHips=document.getElementById("mHips");

  var TRYON_CATS = [
    {key:"top",    label:"Top"},
    {key:"outer",  label:"Outerwear"},
    {key:"bottom", label:"Bottom"},
    {key:"shoe",   label:"Shoes"}
  ];

  function findItemById(id){
    for(var i=0;i<wardrobe.length;i++){ if(wardrobe[i].id===id) return wardrobe[i]; }
    return null;
  }
  function avatarBuildScale(b){
    return {slim:0.86, regular:1, athletic:1.1, broad:1.24}[b] || 1;
  }
  function applyZoneLook(zoneEl, item, neutralColor){
    if(item && item.url){
      zoneEl.style.backgroundColor = "transparent";
      zoneEl.style.backgroundImage = "url('"+item.url+"')";
      zoneEl.style.backgroundSize = item.cutout ? "contain" : "cover";
    } else if(item){
      zoneEl.style.backgroundImage = "none";
      zoneEl.style.backgroundColor = item.color;
    } else {
      zoneEl.style.backgroundImage = "none";
      zoneEl.style.backgroundColor = neutralColor;
    }
  }
  function applyFigureMetrics(){
    var hCm = Math.max(150, Math.min(200, parseInt(avatarState.height,10) || 175));
    var fh = 220 + (hCm-150)/50*110;
    var bs = avatarBuildScale(avatarState.build);
    figure.style.setProperty("--fig-h", fh.toFixed(0)+"px");
    figure.style.setProperty("--head-d", Math.round(fh*0.16)+"px");
    figure.style.setProperty("--torso-w", Math.round(fh*0.42*bs)+"px");
    figure.style.setProperty("--torso-h", Math.round(fh*0.32)+"px");
    figure.style.setProperty("--legs-w", Math.round(fh*0.38*bs)+"px");
    figure.style.setProperty("--legs-h", Math.round(fh*0.40)+"px");
    figure.style.setProperty("--shoe-w", Math.round(fh*0.15*bs)+"px");
  }

  function renderFigure(){
    applyFigureMetrics();

    if(avatarState.face){ figHead.style.backgroundImage = "url('"+avatarState.face+"')"; figHead.style.backgroundSize = "cover"; }
    else { figHead.style.backgroundImage = "none"; figHead.style.backgroundColor = "#E3C49C"; }

    applyZoneLook(figTorso, findItemById(avatarState.picks.top), "#D7D4E0");
    applyZoneLook(figLegs, findItemById(avatarState.picks.bottom), "#C9C6D2");
    var shoeItem = findItemById(avatarState.picks.shoe);
    applyZoneLook(figShoeL, shoeItem, "#2A2A30");
    applyZoneLook(figShoeR, shoeItem, "#2A2A30");

    var outerItem = findItemById(avatarState.picks.outer);
    if(outerItem){ figOuter.hidden = false; applyZoneLook(figOuter, outerItem, "#B58A57"); }
    else { figOuter.hidden = true; }

    tryonStage.dataset.bg = avatarState.bg;
    tryonStage.dataset.zoom = avatarState.zoom;
    zoomClose.classList.toggle("active", avatarState.zoom==="close");
    zoomFar.classList.toggle("active", avatarState.zoom==="far");
    Array.prototype.forEach.call(avBuildSeg.querySelectorAll("button"), function(b){ b.classList.toggle("active", b.getAttribute("data-build")===avatarState.build); });
    Array.prototype.forEach.call(bgSwatches.querySelectorAll("button"), function(b){ b.classList.toggle("active", b.getAttribute("data-bg")===avatarState.bg); });
    avFaceClear.hidden = !avatarState.face;

    tryonEmpty.style.display = wardrobe.length ? "none" : "block";
  }

  function renderTryonPicks(){
    TRYON_CATS.forEach(function(c){
      if(avatarState.picks[c.key] && !findItemById(avatarState.picks[c.key])) avatarState.picks[c.key] = null;
    });
    tryonPicks.innerHTML = "";
    TRYON_CATS.forEach(function(c){
      var row = document.createElement("label");
      row.className = "tryon-pick-row";
      var span = document.createElement("span"); span.textContent = c.label;
      var sel = document.createElement("select"); sel.setAttribute("aria-label", c.label);
      var noneOpt = document.createElement("option"); noneOpt.value=""; noneOpt.textContent="— none —";
      sel.appendChild(noneOpt);
      byCat(c.key).forEach(function(it){
        var o = document.createElement("option"); o.value=String(it.id); o.textContent=it.name;
        if(avatarState.picks[c.key]===it.id) o.selected=true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function(){
        avatarState.picks[c.key] = sel.value ? parseInt(sel.value,10) : null;
        renderFigure(); saveAvatar();
      });
      row.appendChild(span); row.appendChild(sel);
      tryonPicks.appendChild(row);
    });
  }

  function refreshTryonAvailability(){
    renderTryonPicks();
    renderFigure();
  }

  avHeight.addEventListener("input", function(){
    avatarState.height = parseInt(avHeight.value, 10);
    avHeightVal.textContent = avatarState.height;
    renderFigure(); saveAvatar();
  });

  Array.prototype.forEach.call(avBuildSeg.querySelectorAll("button"), function(b){
    b.addEventListener("click", function(){
      avatarState.build = b.getAttribute("data-build");
      renderFigure(); saveAvatar();
    });
  });

  Array.prototype.forEach.call(bgSwatches.querySelectorAll("button"), function(b){
    b.addEventListener("click", function(){
      avatarState.bg = b.getAttribute("data-bg");
      renderFigure(); saveAvatar();
    });
  });

  zoomClose.addEventListener("click", function(){ avatarState.zoom = "close"; renderFigure(); saveAvatar(); });
  zoomFar.addEventListener("click", function(){ avatarState.zoom = "far"; renderFigure(); saveAvatar(); });

  avFaceBtn.addEventListener("click", function(){ avFaceInput.click(); });
  avFaceInput.addEventListener("change", function(){
    var file = avFaceInput.files && avFaceInput.files[0];
    avFaceInput.value = "";
    if(!file || !/^image\//.test(file.type)) return;
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var size = 200;
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var sx = (img.naturalWidth-side)/2, sy = (img.naturalHeight-side)/2;
        var c = document.createElement("canvas"); c.width=size; c.height=size;
        c.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, size, size);
        avatarState.face = c.toDataURL("image/jpeg", 0.85);
        renderFigure(); saveAvatar();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  avFaceClear.addEventListener("click", function(){
    avatarState.face = null;
    renderFigure(); saveAvatar();
  });

  [mHeight, mChest, mWaist, mHips].forEach(function(inp){
    inp.addEventListener("input", function(){
      avatarState.measurements.height = mHeight.value;
      avatarState.measurements.chest = mChest.value;
      avatarState.measurements.waist = mWaist.value;
      avatarState.measurements.hips = mHips.value;
      saveAvatar();
    });
  });

  function initAvatar(){
    loadAvatar();
    avHeight.value = avatarState.height;
    avHeightVal.textContent = avatarState.height;
    mHeight.value = avatarState.measurements.height;
    mChest.value = avatarState.measurements.chest;
    mWaist.value = avatarState.measurements.waist;
    mHips.value = avatarState.measurements.hips;
    renderTryonPicks();
    renderFigure();
  }

  /* ===== trip planning ===== */
  var STORAGE_PLANS = "smartwardrobe:plans";
  var STORAGE_PLAN_NEXTID = "smartwardrobe:plans:nextId";
  var plans = [];
  var nextPlanId = 1;
  var planLocMode = "current";
  var planDest = null; // {lat,lon,label} chosen destination, only used when planLocMode==="destination"

  function persistPlans(){
    try{
      localStorage.setItem(STORAGE_PLANS, JSON.stringify(plans));
      localStorage.setItem(STORAGE_PLAN_NEXTID, String(nextPlanId));
    }catch(e){}
  }
  function restorePlans(){
    try{
      var raw = localStorage.getItem(STORAGE_PLANS);
      if(raw){
        var saved = JSON.parse(raw);
        if(Array.isArray(saved)) plans = saved;
      }
      var savedNextId = parseInt(localStorage.getItem(STORAGE_PLAN_NEXTID), 10);
      nextPlanId = isNaN(savedNextId) ? (plans.reduce(function(m,p){ return Math.max(m, p.id||0); }, 0) + 1) : savedNextId;
    }catch(e){ plans = []; }
  }

  var planForm=document.getElementById("planForm"), planName=document.getElementById("planName"), planDate=document.getElementById("planDate"),
      planLocSeg=document.getElementById("planLocSeg"), planDestWrap=document.getElementById("planDestWrap"),
      planDestInput=document.getElementById("planDestInput"), planDestSearchBtn=document.getElementById("planDestSearchBtn"),
      planDestSuggest=document.getElementById("planDestSuggest"), planDestPicked=document.getElementById("planDestPicked"),
      planFormStatus=document.getElementById("planFormStatus"), planList=document.getElementById("planList"), planEmpty=document.getElementById("planEmpty");

  function setPlanFormStatus(text, isErr){
    planFormStatus.textContent = text || "";
    planFormStatus.classList.toggle("err", !!isErr);
  }

  Array.prototype.forEach.call(planLocSeg.querySelectorAll("button"), function(b){
    b.addEventListener("click", function(){
      planLocMode = b.getAttribute("data-loc");
      Array.prototype.forEach.call(planLocSeg.querySelectorAll("button"), function(x){ x.classList.toggle("active", x===b); });
      planDestWrap.hidden = planLocMode !== "destination";
    });
  });

  function planSearchDestination(){
    var q = planDestInput.value.trim();
    if(!q) return;
    setPlanFormStatus("Searching…");
    planDestSuggest.hidden = true; planDestSuggest.innerHTML = "";
    fetch("https://geocoding-api.open-meteo.com/v1/search?name="+encodeURIComponent(q)+"&count=5&language=en&format=json")
      .then(function(r){ return r.json(); })
      .then(function(d){
        var results = (d && d.results) || [];
        if(!results.length){ setPlanFormStatus("No matching city found.", true); return; }
        setPlanFormStatus("");
        planDestSuggest.hidden = false;
        results.forEach(function(res){
          var label = res.name + (res.admin1?", "+res.admin1:"") + (res.country?", "+res.country:"");
          var b=document.createElement("button"); b.type="button"; b.textContent=label;
          b.addEventListener("click", function(){
            planDestSuggest.hidden = true;
            planDest = {lat:res.latitude, lon:res.longitude, label:label};
            planDestPicked.textContent = "Picked: " + label;
            planDestPicked.classList.add("set");
          });
          planDestSuggest.appendChild(b);
        });
      })
      .catch(function(){ setPlanFormStatus("Couldn't search right now — try again in a moment.", true); });
  }
  planDestSearchBtn.addEventListener("click", planSearchDestination);
  planDestInput.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); planSearchDestination(); } });

  function pad2(n){ return n<10 ? "0"+n : String(n); }
  function dateKey(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
  function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a,b){ return Math.round((startOfDay(b).getTime()-startOfDay(a).getTime())/86400000); }
  function formatPlanDate(dateStr){
    var d = new Date(dateStr+"T00:00:00");
    return d.toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric"});
  }
  function daysUntilLabel(days){
    if(days===0) return "today";
    if(days===1) return "tomorrow";
    if(days>1) return "in "+days+" days";
    return "past";
  }

  function loadPlanForecast(plan, bodyEl){
    fetch("https://api.open-meteo.com/v1/forecast?latitude="+plan.loc.lat+"&longitude="+plan.loc.lon+
          "&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&start_date="+plan.date+"&end_date="+plan.date)
      .then(function(r){ if(!r.ok) throw new Error("forecast failed"); return r.json(); })
      .then(function(data){
        var daily = data && data.daily;
        if(!daily || !daily.time || !daily.time.length) throw new Error("no data");
        var tmax = daily.temperature_2m_max[0], tmin = daily.temperature_2m_min[0];
        var avgT = (tmax+tmin)/2;
        var info = wmoInfo(daily.weather_code[0]);
        var band = tempBand(avgT);
        var rainy = info.group==="rain" || info.group==="storm" || info.group==="snow";
        var needOuter = band==="cold" || band==="cool" || rainy;
        if(!hasEnough()) loadSample();
        var combo = buildOutfit(needOuter);
        var chipText = band==="hot"?"Hot day":band==="warm"?"Warm day":band==="mild"?"Mild day":band==="cool"?"Cool day":"Cold day";
        if(rainy) chipText += " · " + info.label;
        var piecesHtml = combo.map(function(x){
          return '<div class="piece"><div class="swatch" style="'+pieceSwatchStyle(x.item)+'"></div>'+
                 '<div class="nm">'+x.item.name+'</div><div class="ty">'+x.role+'</div></div>';
        }).join("");
        bodyEl.innerHTML =
          '<div class="plan-forecast-row"><span class="pf-emoji">'+info.emoji+'</span>'+
          '<span class="pf-temp">'+Math.round(avgT)+'°</span><span class="pf-cond">'+info.label+'</span></div>'+
          '<div class="outfit show"><div class="outfit-head"><h4>Suggested outfit</h4><span class="occ-chip">'+chipText+'</span></div>'+
          '<div class="pieces">'+piecesHtml+'</div></div>';
      })
      .catch(function(){
        bodyEl.innerHTML = '<p class="plan-pending">Couldn\'t load the forecast — try again later.</p>';
      });
  }

  function renderPlans(){
    planList.innerHTML = "";
    if(!plans.length){
      planList.appendChild(planEmpty);
      return;
    }
    var sorted = plans.slice().sort(function(a,b){ return a.date<b.date?-1:a.date>b.date?1:0; });
    sorted.forEach(function(plan){
      var card = document.createElement("div");
      card.className = "plan-card";
      var head = document.createElement("div");
      head.className = "plan-card-head";
      var info = document.createElement("div");
      var h4 = document.createElement("h4"); h4.textContent = plan.name;
      var days = daysBetween(new Date(), new Date(plan.date+"T00:00:00"));
      var meta = document.createElement("p"); meta.className = "plan-meta";
      meta.textContent = formatPlanDate(plan.date) + " · " + daysUntilLabel(days) + " · 🌍 " + plan.loc.label;
      info.appendChild(h4); info.appendChild(meta);
      var rm = document.createElement("button"); rm.className="plan-rm"; rm.type="button"; rm.setAttribute("aria-label","Remove plan"); rm.textContent="×";
      rm.addEventListener("click", function(){
        plans = plans.filter(function(p){ return p.id!==plan.id; });
        persistPlans(); renderPlans();
      });
      head.appendChild(info); head.appendChild(rm);
      var body = document.createElement("div");
      body.className = "plan-body";
      card.appendChild(head); card.appendChild(body);
      planList.appendChild(card);

      if(days<0){
        body.innerHTML = '<p class="plan-pending">This date has passed.</p>';
      } else if(days>15){
        body.innerHTML = '<p class="plan-pending">Forecast opens up 16 days before the date — check back closer to it.</p>';
      } else {
        body.innerHTML = '<p class="plan-pending">Loading forecast…</p>';
        loadPlanForecast(plan, body);
      }
    });
  }

  planForm.addEventListener("submit", function(e){
    e.preventDefault();
    var name = planName.value.trim();
    var dStr = planDate.value;
    if(!name || !dStr) return;
    setPlanFormStatus("");

    function commit(loc){
      plans.push({id: nextPlanId++, name: name, date: dStr, loc: loc});
      persistPlans();
      planName.value = ""; planDate.value = "";
      planDest = null; planDestPicked.textContent = ""; planDestPicked.classList.remove("set");
      setPlanFormStatus("");
      renderPlans();
    }

    if(planLocMode==="destination"){
      if(!planDest){ setPlanFormStatus("Search and pick a destination city first.", true); return; }
      commit({mode:"destination", lat:planDest.lat, lon:planDest.lon, label:planDest.label});
    } else {
      var saved = loadSavedLoc();
      if(saved && saved.mode==="manual" && saved.lat!=null){
        commit({mode:"current", lat:saved.lat, lon:saved.lon, label:saved.label||"Your current location"});
      } else if(navigator.geolocation){
        setPlanFormStatus("Detecting your location…");
        navigator.geolocation.getCurrentPosition(function(pos){
          commit({mode:"current", lat:pos.coords.latitude, lon:pos.coords.longitude, label:"Your current location"});
        }, function(){
          setPlanFormStatus("Location access denied — choose a destination instead.", true);
        }, {timeout:10000});
      } else {
        setPlanFormStatus("Location isn't available — choose a destination instead.", true);
      }
    }
  });

  function initPlanning(){
    restorePlans();
    planDate.min = dateKey(new Date());
    renderPlans();
  }

  /* ===== init ===== */
  restoreWardrobe();
  renderItems(); renderRail(); updateCounts(); refreshGenAvailability();
  initWeather();
  initAvatar();
  initPlanning();
})();
