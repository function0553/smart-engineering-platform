const api=require('../../utils/api');
Page({
  data:{server:'',username:'',password:'',busy:false,error:''},
  onLoad() { this.setData({server:api.baseUrl()}); if (api.session()) wx.redirectTo({url:'/pages/report/index'}); },
  input(e) { const key=e.currentTarget.dataset.key; if (['server','username','password'].includes(key)) this.setData({[key]:e.detail.value}); },
  async login() {
    if (this.data.busy) return;
    this.setData({busy:true,error:''});
    try {
      api.setBaseUrl(this.data.server);
      if (!this.data.username.trim() || !this.data.password) throw new Error('请填写已有平台账号和密码');
      const result=await api.request('/login','POST',{username:this.data.username.trim(),password:this.data.password});
      api.setSession(result); this.setData({password:''}); wx.redirectTo({url:'/pages/report/index'});
    } catch(e) { this.setData({error:e.message}); } finally {this.setData({busy:false});}
  }
});
