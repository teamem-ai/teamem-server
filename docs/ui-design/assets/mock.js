/* teamem mockup preview helpers: theme persistence + state switcher (preview chrome only) */
(function(){
  var t=null;
  try{t=localStorage.getItem('tm-theme')}catch(e){}
  if(t){document.documentElement.dataset.theme=t}
  window.tmTheme=function(v){
    document.documentElement.dataset.theme=v;
    try{localStorage.setItem('tm-theme',v)}catch(e){}
    document.querySelectorAll('[data-theme-btn]').forEach(function(b){
      b.classList.toggle('on',b.dataset.themeBtn===v);
    });
  };
  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('[data-set]').forEach(function(b){
      b.addEventListener('click',function(){
        document.body.dataset.state=b.dataset.set;
        document.querySelectorAll('[data-set]').forEach(function(x){
          x.classList.toggle('on',x===b);
        });
      });
    });
    document.querySelectorAll('[data-theme-btn]').forEach(function(b){
      b.classList.toggle('on',b.dataset.themeBtn===(document.documentElement.dataset.theme||'light'));
      b.addEventListener('click',function(){window.tmTheme(b.dataset.themeBtn)});
    });
  });
})();
